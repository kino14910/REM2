import { createHash, randomBytes } from 'node:crypto'
import { open, mkdir, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { PluginManagementError } from './errors.js'

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]

export interface DownloadOptions {
  url: string
  destination: string
  signal?: AbortSignal
  onProgress?: (receivedBytes: number, totalBytes?: number) => void
  fetchImpl?: typeof fetch
  allowedHosts?: readonly string[]
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
}

export interface DownloadResult {
  finalUrl: string
  bytes: number
  sha256: string
}

export async function downloadPackage(
  options: DownloadOptions,
): Promise<DownloadResult> {
  const allowedHosts = new Set(
    (options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).map(host =>
      host.toLowerCase(),
    ),
  )
  let currentUrl = parseAllowedUrl(options.url, allowedHosts)
  if (options.signal?.aborted) {
    throw new PluginManagementError('E_CANCELLED', 'download was cancelled', {
      cause: options.signal.reason,
    })
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = options.maxRedirects ?? 5
  const controller = new AbortController()
  let timedOut = false
  let temporaryPath: string | undefined
  let output: FileHandle | undefined
  let committed = false

  const onExternalAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onExternalAbort, { once: true })
  const abortRejection = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(controller.signal.reason),
      { once: true },
    )
  })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('download timed out'))
  }, options.timeoutMs ?? 30_000)

  try {
    let redirects = 0
    let response: Response
    while (true) {
      response = await Promise.race([
        fetchImpl(currentUrl.href, {
          redirect: 'manual',
          signal: controller.signal,
        }),
        abortRejection,
      ])
      if (!REDIRECT_STATUSES.has(response.status)) break
      if (redirects >= maxRedirects) {
        throw new PluginManagementError(
          'E_SOURCE_INVALID',
          `download exceeded the maximum of ${maxRedirects} redirects`,
        )
      }
      const location = response.headers.get('location')
      if (!location) {
        throw new PluginManagementError(
          'E_SOURCE_INVALID',
          'redirect response is missing a Location header',
        )
      }
      let redirectUrl: URL
      try {
        redirectUrl = new URL(location, currentUrl)
      } catch (error) {
        throw new PluginManagementError(
          'E_SOURCE_INVALID',
          'redirect response contains an invalid Location header',
          { cause: error },
        )
      }
      currentUrl = parseAllowedUrl(redirectUrl.href, allowedHosts)
      redirects += 1
    }

    if (response.status < 200 || response.status >= 300) {
      throw new PluginManagementError(
        'E_DOWNLOAD',
        `download failed with HTTP status ${response.status}`,
      )
    }
    const totalBytes = parseContentLength(
      response.headers.get('content-length'),
    )
    if (totalBytes !== undefined && totalBytes > maxBytes) {
      throw new PluginManagementError(
        'E_PACKAGE_TOO_LARGE',
        `package declares ${totalBytes} bytes, exceeding the ${maxBytes} byte limit`,
      )
    }
    if (!response.body) {
      throw new PluginManagementError(
        'E_DOWNLOAD',
        'download response did not contain a body',
      )
    }

    await mkdir(path.dirname(options.destination), { recursive: true })
    temporaryPath = `${options.destination}.part-${process.pid}-${randomBytes(6).toString('hex')}`
    output = await open(temporaryPath, 'wx')

    const hash = createHash('sha256')
    let receivedBytes = 0
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      if (options.signal?.aborted) controller.abort(options.signal.reason)
      controller.signal.throwIfAborted()
      if (receivedBytes + chunk.byteLength > maxBytes) {
        throw new PluginManagementError(
          'E_PACKAGE_TOO_LARGE',
          `package exceeds the ${maxBytes} byte limit while streaming`,
        )
      }
      hash.update(chunk)
      await writeAll(output, chunk)
      receivedBytes += chunk.byteLength
      options.onProgress?.(receivedBytes, totalBytes)
    }
    controller.signal.throwIfAborted()
    await output.close()
    output = undefined
    await rename(temporaryPath, options.destination)
    committed = true

    return {
      finalUrl: currentUrl.href,
      bytes: receivedBytes,
      // This records the downloaded entity only; it is not a trusted release digest.
      sha256: hash.digest('hex'),
    }
  } catch (error) {
    if (error instanceof PluginManagementError) throw error
    if (options.signal?.aborted) {
      throw new PluginManagementError('E_CANCELLED', 'download was cancelled', {
        cause: error,
      })
    }
    if (timedOut) {
      throw new PluginManagementError(
        'E_DOWNLOAD_TIMEOUT',
        `download exceeded the ${options.timeoutMs ?? 30_000} ms total timeout`,
        { cause: error },
      )
    }
    throw new PluginManagementError('E_DOWNLOAD', 'package download failed', {
      cause: error,
    })
  } finally {
    if (output) await output.close().catch(() => undefined)
    if (temporaryPath && !committed) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', onExternalAbort)
  }
}

function parseAllowedUrl(
  value: string,
  allowedHosts: ReadonlySet<string>,
): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new PluginManagementError('E_SOURCE_INVALID', 'invalid package URL', {
      cause: error,
    })
  }
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) {
    throw new PluginManagementError(
      'E_SOURCE_INVALID',
      `package source is not an allowed HTTPS host: ${url.href}`,
    )
  }
  return url
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

async function writeAll(output: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await output.write(
      chunk,
      offset,
      chunk.byteLength - offset,
    )
    if (bytesWritten === 0) throw new Error('failed to advance package write')
    offset += bytesWritten
  }
}
