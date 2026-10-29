import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_ALLOWED_HOSTS,
  downloadPackage,
} from '../../src/host/plugins/remote-download.js'

function fetchStub(
  implementation: (
    ...args: Parameters<typeof fetch>
  ) => ReturnType<typeof fetch>,
): typeof fetch {
  return implementation
}

function responseWithBody(
  body: AsyncIterable<Uint8Array>,
  headers = new Headers(),
): Response {
  return { status: 200, headers, body } as unknown as Response
}

describe('unit · remote package download', () => {
  let root: string
  let destination: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-download-'))
    destination = path.join(root, 'package.zip')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('publishes the default GitHub release asset allowlist', () => {
    expect(DEFAULT_ALLOWED_HOSTS).toEqual([
      'github.com',
      'api.github.com',
      'objects.githubusercontent.com',
      'release-assets.githubusercontent.com',
    ])
  })

  it('rejects HTTPS hosts outside the allowlist before fetching', async () => {
    let called = false
    await expect(
      downloadPackage({
        url: 'https://evil.test/package.zip',
        destination,
        allowedHosts: ['example.test'],
        fetchImpl: fetchStub(async () => {
          called = true
          return new Response('unexpected')
        }),
      }),
    ).rejects.toMatchObject({ code: 'E_SOURCE_INVALID' })
    expect(called).toBe(false)
  })

  it('rejects plain HTTP sources', async () => {
    await expect(
      downloadPackage({
        url: 'http://example.test/package.zip',
        destination,
        allowedHosts: ['example.test'],
        fetchImpl: fetchStub(async () => new Response('unexpected')),
      }),
    ).rejects.toMatchObject({ code: 'E_SOURCE_INVALID' })
  })

  it('rejects redirects to a different host', async () => {
    await expect(
      downloadPackage({
        url: 'https://example.test/package.zip',
        destination,
        allowedHosts: ['example.test'],
        fetchImpl: fetchStub(
          async () =>
            new Response(null, {
              status: 302,
              headers: { location: 'https://evil.test/package.zip' },
            }),
        ),
      }),
    ).rejects.toMatchObject({ code: 'E_SOURCE_INVALID' })
  })

  it('rejects HTTPS-to-HTTP redirect downgrades', async () => {
    await expect(
      downloadPackage({
        url: 'https://example.test/package.zip',
        destination,
        allowedHosts: ['example.test'],
        fetchImpl: fetchStub(
          async () =>
            new Response(null, {
              status: 302,
              headers: { location: 'http://example.test/package.zip' },
            }),
        ),
      }),
    ).rejects.toMatchObject({ code: 'E_SOURCE_INVALID' })
  })

  it('follows a relative redirect and reports the final URL', async () => {
    const payload = new TextEncoder().encode('redirected package')
    const visited: string[] = []
    const result = await downloadPackage({
      url: 'https://example.test/releases/latest',
      destination,
      allowedHosts: ['example.test'],
      fetchImpl: fetchStub(async input => {
        const url = String(input)
        visited.push(url)
        if (url.endsWith('/latest')) {
          return new Response(null, {
            status: 302,
            headers: { location: '../assets/plugin.zip' },
          })
        }
        return new Response(payload)
      }),
    })
    expect(visited).toEqual([
      'https://example.test/releases/latest',
      'https://example.test/assets/plugin.zip',
    ])
    expect(result.finalUrl).toBe('https://example.test/assets/plugin.zip')
    expect(await readFile(destination)).toEqual(Buffer.from(payload))
  })

  it('rejects redirect responses without a Location header', async () => {
    await expect(
      downloadPackage({
        url: 'https://example.test/package.zip',
        destination,
        allowedHosts: ['example.test'],
        fetchImpl: fetchStub(async () => new Response(null, { status: 302 })),
      }),
    ).rejects.toMatchObject({ code: 'E_SOURCE_INVALID' })
  })

  it('rejects redirect loops beyond maxRedirects', async () => {
    await expect(
      downloadPackage({
        url: 'https://example.test/package.zip',
        destination,
        allowedHosts: ['example.test'],
        maxRedirects: 1,
        fetchImpl: fetchStub(
          async () =>
            new Response(null, {
              status: 302,
              headers: { location: '/next' },
            }),
        ),
      }),
    ).rejects.toMatchObject({ code: 'E_SOURCE_INVALID' })
  })

  it('rejects an oversized content-length before creating a temp file', async () => {
    await expect(
      downloadPackage({
        url: 'https://example.test/package.zip',
        destination,
        allowedHosts: ['example.test'],
        maxBytes: 4,
        fetchImpl: fetchStub(
          async () =>
            new Response(new Uint8Array([1, 2, 3]), {
              headers: { 'content-length': '100' },
            }),
        ),
      }),
    ).rejects.toMatchObject({ code: 'E_PACKAGE_TOO_LARGE' })
    expect(await readdir(root)).toEqual([])
  })

  it('enforces maxBytes while streaming and removes the partial file', async () => {
    const body = (async function* () {
      yield new Uint8Array([1, 2, 3])
      yield new Uint8Array([4, 5, 6])
    })()
    await expect(
      downloadPackage({
        url: 'https://example.test/package.zip',
        destination,
        allowedHosts: ['example.test'],
        maxBytes: 4,
        fetchImpl: fetchStub(async () => responseWithBody(body)),
      }),
    ).rejects.toMatchObject({ code: 'E_PACKAGE_TOO_LARGE' })
    expect(await readdir(root)).toEqual([])
  })

  it('times out even when the fetch implementation never settles', async () => {
    await expect(
      downloadPackage({
        url: 'https://example.test/package.zip',
        destination,
        allowedHosts: ['example.test'],
        timeoutMs: 10,
        fetchImpl: fetchStub(() => new Promise<Response>(() => undefined)),
      }),
    ).rejects.toMatchObject({ code: 'E_DOWNLOAD_TIMEOUT' })
  })

  it('gives an external AbortSignal cancellation semantics', async () => {
    const controller = new AbortController()
    const pending = downloadPackage({
      url: 'https://example.test/package.zip',
      destination,
      allowedHosts: ['example.test'],
      signal: controller.signal,
      timeoutMs: 1_000,
      fetchImpl: fetchStub(() => new Promise<Response>(() => undefined)),
    })
    controller.abort(new Error('cancelled by caller'))
    await expect(pending).rejects.toMatchObject({ code: 'E_CANCELLED' })
  })

  it('includes the HTTP status for non-success responses', async () => {
    await expect(
      downloadPackage({
        url: 'https://example.test/missing.zip',
        destination,
        allowedHosts: ['example.test'],
        fetchImpl: fetchStub(
          async () => new Response('missing', { status: 404 }),
        ),
      }),
    ).rejects.toMatchObject({
      code: 'E_DOWNLOAD',
      message: expect.stringContaining('404'),
    })
  })

  it('cleans the temporary file when a response stream fails', async () => {
    const body = (async function* () {
      yield new Uint8Array([1, 2, 3])
      throw new Error('connection lost')
    })()
    await expect(
      downloadPackage({
        url: 'https://example.test/package.zip',
        destination,
        allowedHosts: ['example.test'],
        fetchImpl: fetchStub(async () => responseWithBody(body)),
      }),
    ).rejects.toMatchObject({ code: 'E_DOWNLOAD' })
    expect(await readdir(root)).toEqual([])
  })

  it('writes the exact entity, hashes it, and reports progress', async () => {
    const payload = new TextEncoder().encode('remote plugin archive')
    const expectedHash = createHash('sha256').update(payload).digest('hex')
    const progress: Array<[number, number | undefined]> = []
    const nestedDestination = path.join(root, 'downloads', 'plugin.zip')
    const result = await downloadPackage({
      url: 'https://example.test/plugin.zip',
      destination: nestedDestination,
      allowedHosts: ['example.test'],
      fetchImpl: fetchStub(
        async () =>
          new Response(payload, {
            headers: { 'content-length': String(payload.byteLength) },
          }),
      ),
      onProgress: (received, total) => progress.push([received, total]),
    })
    expect(result).toEqual({
      finalUrl: 'https://example.test/plugin.zip',
      bytes: payload.byteLength,
      sha256: expectedHash,
    })
    expect(await readFile(nestedDestination)).toEqual(Buffer.from(payload))
    expect(progress.at(-1)).toEqual([payload.byteLength, payload.byteLength])
    expect(await readdir(path.dirname(nestedDestination))).toEqual([
      'plugin.zip',
    ])
  })
})
