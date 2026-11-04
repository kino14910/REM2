import type { RegistryCache } from './cache.js'
import type { RegistryIndex } from './types.js'

import { RegistryClientError, isRegistryNetworkFailure } from './errors.js'
import { parseRegistryIndexJson } from './parser.js'

/** Stable official registry URL documented in REM2-plugins. */
export const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/kino14910/REM2-plugins/main/registry/index.json'

/** Metadata host for the official registry; release assets have their own allowlist. */
export const DEFAULT_REGISTRY_ALLOWED_HOSTS: readonly string[] = [
  'raw.githubusercontent.com',
]

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export interface RegistryClientOptions {
  /** Defaults to the official registry index. */
  url?: string
  /** Injected for tests and for the Electron session fetch adapter. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxBytes?: number
  /** Hosts the registry URL and its redirects may use. */
  allowedHosts?: readonly string[]
  /** Last known good index store; omit to disable cache fallback. */
  cache?: RegistryCache | null
  now?: () => Date
}

export interface RegistryFetchOptions {
  signal?: AbortSignal
  /** Cache fallback is enabled by default; set false to require a live fetch. */
  allowCache?: boolean
}

export interface RegistrySnapshot {
  url: string
  index: RegistryIndex
  source: 'network' | 'cache'
  /** Successful fetch time for network data, original fetch time for cache data. */
  fetchedAt: string
  /** Time this call completed its check. */
  checkedAt: string
  /** Non-fatal issues (cache write failure, or the reason a stale index is shown). */
  warnings: string[]
  /** True when the network failed and the cached index is being shown. */
  stale: boolean
}

interface RegistryRequestOptions {
  url: string
  fetchImpl: typeof fetch
  allowedHosts: ReadonlySet<string>
  timeoutMs: number
  maxBytes: number
  signal?: AbortSignal
}

/**
 * Fetch and validate the remote registry index.
 *
 * This client never installs anything: it produces a validated snapshot, and
 * installation still goes through the existing remote install path with the
 * entry's `downloadUrl` and `sha256`.
 */
export class RegistryClient {
  readonly url: string
  private readonly fetchImpl: typeof fetch
  private readonly allowedHosts: ReadonlySet<string>
  private readonly timeoutMs: number
  private readonly maxBytes: number
  private readonly cache: RegistryCache | null
  private readonly now: () => Date

  constructor(options: RegistryClientOptions = {}) {
    const allowedHosts = new Set(
      (options.allowedHosts ?? DEFAULT_REGISTRY_ALLOWED_HOSTS).map(host =>
        host.toLowerCase(),
      ),
    )
    this.url = assertAllowedUrl(
      options.url ?? DEFAULT_REGISTRY_URL,
      allowedHosts,
    ).href
    this.fetchImpl = options.fetchImpl ?? fetch
    this.allowedHosts = allowedHosts
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.cache = options.cache ?? null
    this.now = options.now ?? (() => new Date())
  }

  async fetch(options: RegistryFetchOptions = {}): Promise<RegistrySnapshot> {
    const { signal, allowCache = true } = options
    if (signal?.aborted) {
      throw new RegistryClientError(
        'E_REGISTRY_CANCELLED',
        'registry request was cancelled',
        { cause: signal.reason },
      )
    }
    const checkedAt = this.now().toISOString()

    try {
      const text = await fetchIndexText({
        url: this.url,
        fetchImpl: this.fetchImpl,
        allowedHosts: this.allowedHosts,
        timeoutMs: this.timeoutMs,
        maxBytes: this.maxBytes,
        ...(signal ? { signal } : {}),
      })
      const index = parseRegistryIndexJson(text)
      const fetchedAt = this.now().toISOString()
      const warnings: string[] = []

      if (this.cache !== null) {
        try {
          await this.cache.write({
            sourceUrl: this.url,
            fetchedAt,
            index,
          })
        } catch (error) {
          warnings.push(
            `registry index was fetched but the cache could not be updated: ${errorMessage(error)}`,
          )
        }
      }

      return {
        url: this.url,
        index,
        source: 'network',
        fetchedAt,
        checkedAt,
        warnings,
        stale: false,
      }
    } catch (error) {
      if (signal?.aborted) {
        throw new RegistryClientError(
          'E_REGISTRY_CANCELLED',
          'registry request was cancelled',
          { cause: signal.reason },
        )
      }
      if (!isRegistryNetworkFailure(error)) throw error
      if (!allowCache || this.cache === null) throw error

      let cached
      try {
        cached = await this.cache.read(this.url)
      } catch (cacheError) {
        throw new RegistryClientError(
          error.code,
          `${error.message} (cache could not be read: ${errorMessage(cacheError)})`,
          { cause: error },
        )
      }

      if (cached.status === 'hit') {
        return {
          url: this.url,
          index: cached.entry.index,
          source: 'cache',
          fetchedAt: cached.entry.fetchedAt,
          checkedAt,
          warnings: [
            `registry request failed: ${error.message}; showing the index fetched at ${cached.entry.fetchedAt}`,
          ],
          stale: true,
        }
      }
      if (cached.status === 'invalid') {
        throw new RegistryClientError(
          error.code,
          `${error.message} (cached index is unusable: ${cached.reason})`,
          { cause: error },
        )
      }
      throw error
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertAllowedUrl(
  value: string | URL,
  allowedHosts: ReadonlySet<string>,
): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new RegistryClientError(
      'E_REGISTRY_SOURCE_INVALID',
      `invalid registry URL: ${String(value)}`,
      { cause: error },
    )
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    !allowedHosts.has(url.hostname.toLowerCase())
  ) {
    throw new RegistryClientError(
      'E_REGISTRY_SOURCE_INVALID',
      `registry URL is not an allowed HTTPS host: ${url.href}`,
    )
  }
  return url
}

async function fetchIndexText(
  options: RegistryRequestOptions,
): Promise<string> {
  const controller = new AbortController()
  const onExternalAbort = (): void => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) onExternalAbort()
  else
    options.signal?.addEventListener('abort', onExternalAbort, { once: true })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)

  let currentUrl = assertAllowedUrl(options.url, options.allowedHosts)
  try {
    let response: Response | undefined
    for (let redirects = 0; ; redirects += 1) {
      response = await options.fetchImpl(currentUrl.href, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { Accept: 'application/json' },
      })
      if (!REDIRECT_STATUSES.has(response.status)) break

      if (redirects >= MAX_REDIRECTS) {
        throw new RegistryClientError(
          'E_REGISTRY_SOURCE_INVALID',
          `registry request exceeded the maximum of ${MAX_REDIRECTS} redirects`,
        )
      }
      const location = response.headers.get('location')
      if (location === null) {
        throw new RegistryClientError(
          'E_REGISTRY_SOURCE_INVALID',
          'registry redirect is missing a Location header',
        )
      }

      let next: URL
      try {
        next = new URL(location, currentUrl)
      } catch (error) {
        throw new RegistryClientError(
          'E_REGISTRY_SOURCE_INVALID',
          'registry redirect contains an invalid URL',
          { cause: error },
        )
      }
      await response.body?.cancel().catch(() => undefined)
      currentUrl = assertAllowedUrl(next, options.allowedHosts)
    }

    if (response === undefined) {
      throw new RegistryClientError(
        'E_REGISTRY_NETWORK',
        `registry request returned no response: ${options.url}`,
      )
    }
    if (!response.ok) {
      throw new RegistryClientError(
        'E_REGISTRY_HTTP',
        `registry request failed with HTTP ${response.status}: ${options.url}`,
      )
    }
    if (!response.body) return ''
    return await readResponseText(response, options.maxBytes)
  } catch (error) {
    if (options.signal?.aborted) {
      throw new RegistryClientError(
        'E_REGISTRY_CANCELLED',
        'registry request was cancelled',
        { cause: error },
      )
    }
    if (timedOut) {
      throw new RegistryClientError(
        'E_REGISTRY_TIMEOUT',
        `registry request timed out after ${options.timeoutMs} ms: ${options.url}`,
        { cause: error },
      )
    }
    if (error instanceof RegistryClientError) throw error
    throw new RegistryClientError(
      'E_REGISTRY_NETWORK',
      `registry request failed: ${options.url}`,
      { cause: error },
    )
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onExternalAbort)
  }
}

async function readResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredBytes = parseContentLength(
    response.headers.get('content-length'),
  )
  if (declaredBytes !== undefined && declaredBytes > maxBytes) {
    throw new RegistryClientError(
      'E_REGISTRY_TOO_LARGE',
      `registry response declares ${declaredBytes} bytes, exceeding the ${maxBytes} byte limit`,
    )
  }

  const decoder = new TextDecoder()
  let receivedBytes = 0
  let text = ''
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    receivedBytes += chunk.byteLength
    if (receivedBytes > maxBytes) {
      throw new RegistryClientError(
        'E_REGISTRY_TOO_LARGE',
        `registry response exceeds the ${maxBytes} byte limit while streaming`,
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
