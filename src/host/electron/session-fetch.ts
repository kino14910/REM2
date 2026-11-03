import type { ClientRequest, IncomingMessage, Session } from 'electron'

import { net } from 'electron'

/**
 * `fetch` adapter over Electron's `ClientRequest`.
 *
 * Why not `net.fetch`? It rejects `redirect: 'manual'`, which is required to
 * validate every redirect hop against the release allowlist. `ClientRequest`
 * uses the same Chromium session (and therefore the configured proxy) while
 * exposing redirect events.
 */
export function createSessionFetch(electronSession: Session): typeof fetch {
  const fetchImpl = (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => requestUrl(input, init, electronSession)

  return fetchImpl as typeof fetch
}

function requestUrl(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  electronSession: Session,
): Promise<Response> {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url
  const headers = new Headers(init?.headers)
  // ClientRequest exposes decoded data but may retain the compressed header.
  // Ask for identity so callers can safely treat metadata as UTF-8 text.
  if (!headers.has('accept-encoding'))
    headers.set('accept-encoding', 'identity')
  const redirect =
    init?.redirect === 'manual'
      ? 'manual'
      : init?.redirect === 'error'
        ? 'error'
        : 'follow'

  return new Promise<Response>((resolve, reject) => {
    let settled = false
    let request: ClientRequest
    const settle = (value: Response): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const abort = (): void => {
      request.abort()
      fail(
        init?.signal?.reason ??
          new DOMException('The request was aborted', 'AbortError'),
      )
    }

    try {
      request = net.request({
        url,
        method: init?.method ?? 'GET',
        session: electronSession,
        redirect,
        headers: Object.fromEntries(headers.entries()),
      })
    } catch (error) {
      fail(error)
      return
    }

    if (init?.signal?.aborted) {
      abort()
      return
    }
    init?.signal?.addEventListener('abort', abort, { once: true })

    request.on(
      'redirect',
      (statusCode, _method, redirectUrl, responseHeaders) => {
        if (redirect === 'manual') {
          const redirectHeaders = headersFrom(responseHeaders)
          redirectHeaders.set('location', redirectUrl)
          settle(
            new Response(null, {
              status: statusCode,
              headers: redirectHeaders,
            }),
          )
          request.abort()
          return
        }
        request.followRedirect()
      },
    )

    request.on('response', (response: IncomingMessage) => {
      const responseHeaders = headersFrom(response.headers)
      const nullBodyStatus = [101, 204, 205, 304].includes(response.statusCode)
      const body = nullBodyStatus
        ? null
        : new ReadableStream<Uint8Array>({
            start(controller) {
              response.on('data', (chunk: Buffer) => {
                controller.enqueue(new Uint8Array(chunk))
              })
              response.on('end', () => {
                controller.close()
              })
              response.on('error', error => {
                controller.error(error)
              })
              response.on('aborted', () => {
                controller.error(new Error('response was aborted'))
              })
            },
          })
      settle(
        new Response(body, {
          status: response.statusCode,
          headers: responseHeaders,
        }),
      )
    })

    request.on('error', fail)
    request.on('close', () => {
      init?.signal?.removeEventListener('abort', abort)
    })
    request.end()
  })
}

function headersFrom(source: Record<string, string | string[]>): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(source)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item)
    }
  }
  return headers
}
