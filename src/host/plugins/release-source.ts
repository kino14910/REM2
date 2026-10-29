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
}

interface RequestOptions {
  fetchImpl: typeof fetch
  timeoutMs: number
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
    if (url.pathname.toLowerCase().endsWith('.zip')) {
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
  try {
    const text = await fetchText(validateAssetUrl(sidecar.downloadUrl), options)
    const parsed = parseSha256Text(text)
    if (typeof parsed !== 'string') return undefined
    const normalized = parsed.toLowerCase()
    return isSha256(normalized) ? normalized : undefined
  } catch {
    return undefined
  }
}

async function fetchJson(
  url: string,
  options: RequestOptions,
): Promise<unknown> {
  return fetchWithTimeout(url, options, response => response.json())
}

async function fetchText(
  url: string,
  options: RequestOptions,
): Promise<string> {
  return fetchWithTimeout(url, options, response => response.text())
}

async function fetchWithTimeout<T>(
  url: string,
  options: RequestOptions,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const response = await options.fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!response.ok) {
      throw new PluginManagementError(
        'E_DOWNLOAD',
        `release request failed with HTTP ${response.status}: ${url}`,
      )
    }
    return await consume(response)
  } catch (error) {
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
  }
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
