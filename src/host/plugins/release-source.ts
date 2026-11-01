import { PluginManagementError } from './errors.js'
import { isSha256, parseSha256Text } from './integrity.js'

export interface RemoteRelease {
  sourceUrl: string
  downloadUrl: string
  version: string
  publishedAt?: string
  notes?: string
  sha256?: string
  size?: number
}

export interface ResolveReleaseOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}

interface RequestOptions {
  fetchImpl: typeof fetch
  timeoutMs: number
  signal?: AbortSignal
}

interface GitHubAsset {
  name: string
  downloadUrl: string
  digest?: string
  size?: number
}

interface GitHubRelease {
  tag: string
  publishedAt?: string
  notes?: string
  assets: GitHubAsset[]
}

type GitHubSource =
  | { kind: 'latest'; owner: string; repo: string }
  | { kind: 'tag'; owner: string; repo: string; tag: string }
  | {
      kind: 'download'
      owner: string
      repo: string
      tag: string
      assetName: string
    }

type ParsedSource =
  | { kind: 'direct'; url: string }
  | { kind: 'github'; source: GitHubSource }

const ALLOWED_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])
const RELEASE_METADATA_MAX_BYTES = 1024 * 1024
const SIDECAR_MAX_BYTES = 16 * 1024

export async function resolveRemoteRelease(
  source: string,
  options: ResolveReleaseOptions = {},
): Promise<RemoteRelease> {
  const parsed = parseSource(source)
  if (parsed.kind === 'direct') {
    return {
      sourceUrl: source,
      downloadUrl: parsed.url,
      // Empty means no reliable semver could be inferred from the filename.
      version: inferVersion(parsed.url),
    }
  }

  const requestOptions: RequestOptions = {
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? 15_000,
    ...(options.signal ? { signal: options.signal } : {}),
  }
  const github = parsed.source
  if (github.kind === 'download') {
    const fallback: RemoteRelease = {
      sourceUrl: source,
      downloadUrl: source,
      version: normalizeTag(github.tag),
    }
    let release: GitHubRelease
    try {
      release = await fetchRelease(github, requestOptions)
    } catch (error) {
      if (
        error instanceof PluginManagementError &&
        error.code === 'E_DOWNLOAD' &&
        error.cause !== undefined
      ) {
        return fallback
      }
      throw error
    }
    const asset = release.assets.find(item => item.name === github.assetName)
    const sha256 = asset
      ? await resolveSha256(asset, release.assets, requestOptions)
      : undefined
    return {
      ...fallback,
      ...optionalReleaseFields(release),
      ...(asset?.size === undefined ? {} : { size: asset.size }),
      ...(sha256 === undefined ? {} : { sha256 }),
    }
  }

  const release = await fetchRelease(github, requestOptions)
  const zipAssets = release.assets.filter(asset =>
    asset.name.toLowerCase().endsWith('.zip'),
  )
  if (zipAssets.length !== 1) {
    throw new PluginManagementError(
      'E_SOURCE_INVALID',
      `release must contain exactly one .zip asset; found ${zipAssets.length}`,
    )
  }
  const asset = zipAssets[0]
  const sha256 = await resolveSha256(asset, release.assets, requestOptions)
  return {
    sourceUrl: source,
    downloadUrl: validateAssetUrl(asset.downloadUrl),
    version: normalizeTag(release.tag),
    ...optionalReleaseFields(release),
    ...(asset.size === undefined ? {} : { size: asset.size }),
    ...(sha256 === undefined ? {} : { sha256 }),
  }
}

function parseSource(source: string): ParsedSource {
  let url: URL
  try {
    url = new URL(source)
  } catch (error) {
    throw new PluginManagementError('E_SOURCE_INVALID', 'invalid source URL', {
      cause: error,
    })
  }
  if (url.protocol !== 'https:') {
    throw new PluginManagementError(
      'E_SOURCE_INVALID',
      'only HTTPS release sources are supported',
    )
  }

  const host = url.hostname.toLowerCase()
  if (host !== 'github.com') {
    if (
      ALLOWED_HOSTS.has(host) &&
      url.pathname.toLowerCase().endsWith('.zip')
    ) {
      return { kind: 'direct', url: source }
    }
    throw new PluginManagementError(
      'E_SOURCE_INVALID',
      ALLOWED_HOSTS.has(host)
        ? 'direct release URLs must identify a .zip asset'
        : `unsupported release source host: ${host}`,
    )
  }

  let parts: string[]
  try {
    parts = url.pathname
      .split('/')
      .filter(Boolean)
      .map(part => decodeURIComponent(part))
  } catch (error) {
    throw new PluginManagementError(
      'E_SOURCE_INVALID',
      'invalid escaped GitHub source path',
      { cause: error },
    )
  }
  const [owner, repo] = parts
  if (owner === undefined || repo === undefined) {
    throw new PluginManagementError(
      'E_SOURCE_INVALID',
      'unsupported GitHub release URL',
    )
  }
  if (parts.length === 2) {
    return { kind: 'github', source: { kind: 'latest', owner, repo } }
  }
  if (parts.length === 4 && parts[2] === 'releases' && parts[3] === 'latest') {
    return { kind: 'github', source: { kind: 'latest', owner, repo } }
  }
  const tag = parts[4]
  if (
    parts.length === 5 &&
    parts[2] === 'releases' &&
    parts[3] === 'tag' &&
    tag !== undefined
  ) {
    return { kind: 'github', source: { kind: 'tag', owner, repo, tag } }
  }
  const assetName = parts[5]
  if (
    parts.length === 6 &&
    parts[2] === 'releases' &&
    parts[3] === 'download' &&
    tag !== undefined &&
    assetName?.toLowerCase().endsWith('.zip')
  ) {
    return {
      kind: 'github',
      source: { kind: 'download', owner, repo, tag, assetName },
    }
  }
  throw new PluginManagementError(
    'E_SOURCE_INVALID',
    'unsupported GitHub release URL',
  )
}

async function fetchRelease(
  source: GitHubSource,
  options: RequestOptions,
): Promise<GitHubRelease> {
  const suffix =
    source.kind === 'latest'
      ? 'latest'
      : `tags/${encodeURIComponent(source.tag)}`
  const url = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/releases/${suffix}`
  return parseGitHubRelease(await fetchJson(url, options))
}

function parseGitHubRelease(value: unknown): GitHubRelease {
  if (
    !isRecord(value) ||
    typeof value.tag_name !== 'string' ||
    !Array.isArray(value.assets)
  ) {
    throw new PluginManagementError(
      'E_DOWNLOAD',
      'GitHub returned invalid release metadata',
    )
  }
  const assets = value.assets.flatMap(item => {
    if (
      !isRecord(item) ||
      typeof item.name !== 'string' ||
      typeof item.browser_download_url !== 'string'
    ) {
      return []
    }
    return [
      {
        name: item.name,
        downloadUrl: item.browser_download_url,
        ...(typeof item.digest === 'string' ? { digest: item.digest } : {}),
        ...(typeof item.size === 'number' && Number.isFinite(item.size)
          ? { size: item.size }
          : {}),
      },
    ]
  })
  return {
    tag: value.tag_name,
    ...(typeof value.published_at === 'string'
      ? { publishedAt: value.published_at }
      : {}),
    ...(typeof value.body === 'string' ? { notes: value.body } : {}),
    assets,
  }
}

function validateAssetUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new PluginManagementError('E_SOURCE_INVALID', 'invalid asset URL', {
      cause: error,
    })
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new PluginManagementError(
      'E_SOURCE_INVALID',
      'GitHub asset URL uses an unsupported host or scheme',
    )
  }
  return value
}

async function resolveSha256(
  asset: GitHubAsset,
  assets: GitHubAsset[],
  options: RequestOptions,
): Promise<string | undefined> {
  if (asset.digest?.toLowerCase().startsWith('sha256:')) {
    const digest = asset.digest.slice('sha256:'.length).toLowerCase()
    if (isSha256(digest)) return digest
  }
  const sidecar = assets.find(item => item.name === `${asset.name}.sha256`)
  if (!sidecar) return undefined
  const text = await fetchText(validateAssetUrl(sidecar.downloadUrl), options)
  const parsed = parseSha256Text(text)
  if (typeof parsed !== 'string') return undefined
  const normalized = parsed.toLowerCase()
  return isSha256(normalized) ? normalized : undefined
}

async function fetchJson(
  url: string,
  options: RequestOptions,
): Promise<unknown> {
  return fetchWithTimeout(
    url,
    options,
    RELEASE_METADATA_MAX_BYTES,
    text => JSON.parse(text) as unknown,
  )
}

async function fetchText(
  url: string,
  options: RequestOptions,
): Promise<string> {
  return fetchWithTimeout(url, options, SIDECAR_MAX_BYTES, text => text)
}

async function fetchWithTimeout<T>(
  url: string,
  options: RequestOptions,
  maxBytes: number,
  consume: (text: string) => T,
): Promise<T> {
  const controller = new AbortController()
  const onExternalAbort = (): void => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) onExternalAbort()
  else
    options.signal?.addEventListener('abort', onExternalAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  let currentUrl = assertAllowedFetchUrl(url)
  try {
    let response: Response | undefined
    for (let redirects = 0; ; redirects += 1) {
      response = await options.fetchImpl(currentUrl.href, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { Accept: 'application/vnd.github+json' },
      })
      if (!REDIRECT_STATUSES.has(response.status)) break
      if (redirects >= MAX_REDIRECTS) {
        throw new PluginManagementError(
          'E_SOURCE_INVALID',
          `release request exceeded the maximum of ${MAX_REDIRECTS} redirects`,
        )
      }
      const location = response.headers.get('location')
      if (!location) {
        throw new PluginManagementError(
          'E_SOURCE_INVALID',
          'release redirect is missing a Location header',
        )
      }
      await response.body?.cancel().catch(() => undefined)
      currentUrl = assertAllowedFetchUrl(new URL(location, currentUrl).href)
    }
    if (!response.ok) {
      throw new PluginManagementError(
        'E_DOWNLOAD',
        `release request failed with HTTP ${response.status}: ${url}`,
      )
    }
    return consume(await readResponseText(response, maxBytes))
  } catch (error) {
    if (options.signal?.aborted) {
      throw new PluginManagementError(
        'E_CANCELLED',
        'release request was cancelled',
        { cause: error },
      )
    }
    if (controller.signal.aborted) {
      throw new PluginManagementError(
        'E_DOWNLOAD_TIMEOUT',
        `release request timed out: ${url}`,
        { cause: error },
      )
    }
    if (error instanceof PluginManagementError) throw error
    throw new PluginManagementError(
      'E_DOWNLOAD',
      `release request failed: ${url}`,
      { cause: error },
    )
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onExternalAbort)
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5

function assertAllowedFetchUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new PluginManagementError(
      'E_SOURCE_INVALID',
      'release redirect contains an invalid URL',
      { cause: error },
    )
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new PluginManagementError(
      'E_SOURCE_INVALID',
      `release request left the HTTPS allowlist: ${url.href}`,
    )
  }
  return url
}

async function readResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredBytes = parseContentLength(
    response.headers.get('content-length'),
  )
  if (declaredBytes !== undefined && declaredBytes > maxBytes) {
    throw new PluginManagementError(
      'E_DOWNLOAD',
      `release response declares ${declaredBytes} bytes, exceeding the ${maxBytes} byte limit`,
    )
  }
  if (!response.body) {
    throw new PluginManagementError(
      'E_DOWNLOAD',
      'release response did not contain a body',
    )
  }

  const decoder = new TextDecoder()
  let receivedBytes = 0
  let text = ''
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    receivedBytes += chunk.byteLength
    if (receivedBytes > maxBytes) {
      throw new PluginManagementError(
        'E_DOWNLOAD',
        `release response exceeds the ${maxBytes} byte limit while streaming`,
      )
    }
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function optionalReleaseFields(
  release: GitHubRelease,
): Pick<RemoteRelease, 'publishedAt' | 'notes'> {
  return {
    ...(release.publishedAt === undefined
      ? {}
      : { publishedAt: release.publishedAt }),
    ...(release.notes === undefined ? {} : { notes: release.notes }),
  }
}

function normalizeTag(tag: string): string {
  return tag.replace(/^v/i, '')
}

function inferVersion(source: string): string {
  try {
    const url = new URL(source)
    const filename = decodeURIComponent(
      url.pathname.slice(url.pathname.lastIndexOf('/') + 1),
    ).replace(/\.zip$/i, '')
    const match =
      /(?:^|[^0-9A-Za-z])v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=$|[^0-9A-Za-z])/i.exec(
        filename,
      )
    return match?.[1] ?? ''
  } catch {
    return ''
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
