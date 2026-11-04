import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RegistryCache } from '@/host/registry/cache.js'
import { DEFAULT_REGISTRY_URL, RegistryClient } from '@/host/registry/client.js'
import { RegistryClientError } from '@/host/registry/errors.js'

import { makeRegistryIndex } from '../helpers/registry-index.js'

const cachedFetchedAt = '2026-11-04T06:00:00.000Z'
const now = (): Date => new Date('2026-11-04T07:00:00.000Z')

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location },
  })
}

function hangingFetch(): typeof fetch {
  return vi.fn<typeof fetch>((_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      const abort = (): void => {
        reject(new DOMException('Aborted', 'AbortError'))
      }
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
  })
}

async function clientError(
  action: () => Promise<unknown>,
): Promise<RegistryClientError> {
  try {
    await action()
  } catch (error) {
    if (error instanceof RegistryClientError) return error
    throw error
  }
  throw new Error('expected a RegistryClientError')
}

function syncError(action: () => unknown): RegistryClientError {
  try {
    action()
  } catch (error) {
    if (error instanceof RegistryClientError) return error
    throw error
  }
  throw new Error('expected a RegistryClientError')
}

describe('unit · registry client', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  async function cachePath(): Promise<string> {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-registry-client-'))
    return path.join(root, 'registry-cache.json')
  }

  async function seededCache(): Promise<RegistryCache> {
    const cache = new RegistryCache(await cachePath())
    await cache.write({
      sourceUrl: DEFAULT_REGISTRY_URL,
      fetchedAt: cachedFetchedAt,
      index: makeRegistryIndex(),
    })
    return cache
  }

  it('fetches, validates and caches a remote index', async () => {
    const cache = new RegistryCache(await cachePath())
    const index = makeRegistryIndex()
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(index))
    const client = new RegistryClient({ cache, fetchImpl, now })

    const snapshot = await client.fetch()

    expect(snapshot).toMatchObject({
      url: DEFAULT_REGISTRY_URL,
      source: 'network',
      stale: false,
      warnings: [],
    })
    expect(snapshot.index).toEqual(index)
    expect(snapshot.fetchedAt).toBe(now().toISOString())
    expect(snapshot.checkedAt).toBe(now().toISOString())
    await expect(cache.read(DEFAULT_REGISTRY_URL)).resolves.toEqual({
      status: 'hit',
      entry: {
        sourceUrl: DEFAULT_REGISTRY_URL,
        fetchedAt: snapshot.fetchedAt,
        index,
      },
    })
  })

  it('sends Accept: application/json and follows allowlisted redirects', async () => {
    const firstUrl = 'https://raw.githubusercontent.com/test/moved.json'
    const secondUrl = DEFAULT_REGISTRY_URL
    const seen: string[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      seen.push(url)
      expect(new Headers(init?.headers).get('accept')).toBe('application/json')
      return url === firstUrl
        ? redirectResponse(secondUrl)
        : jsonResponse(makeRegistryIndex())
    })
    const client = new RegistryClient({ url: firstUrl, fetchImpl, now })

    const snapshot = await client.fetch()

    expect(seen).toEqual([firstUrl, secondUrl])
    expect(snapshot.url).toBe(firstUrl)
    expect(snapshot.index).toEqual(makeRegistryIndex())
  })

  it('rejects redirects that leave the allowlist', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      redirectResponse('https://evil.example/index.json'),
    )
    const client = new RegistryClient({ fetchImpl, now })

    const error = await clientError(() => client.fetch())
    expect(error.code).toBe('E_REGISTRY_SOURCE_INVALID')
  })

  it('rejects non-allowlisted or non-HTTPS registry URLs', () => {
    expect(
      syncError(
        () =>
          new RegistryClient({
            url: 'https://evil.example/index.json',
          }),
      ).code,
    ).toBe('E_REGISTRY_SOURCE_INVALID')

    expect(
      syncError(
        () =>
          new RegistryClient({
            url: 'http://raw.githubusercontent.com/kino14910/REM2-plugins/main/registry/index.json',
          }),
      ).code,
    ).toBe('E_REGISTRY_SOURCE_INVALID')
  })

  it('falls back to the cached index on an HTTP error', async () => {
    const cache = await seededCache()
    const client = new RegistryClient({
      cache,
      fetchImpl: vi.fn<typeof fetch>(
        async () => new Response('boom', { status: 500 }),
      ),
      now,
    })

    const snapshot = await client.fetch()

    expect(snapshot.source).toBe('cache')
    expect(snapshot.stale).toBe(true)
    expect(snapshot.fetchedAt).toBe(cachedFetchedAt)
    expect(snapshot.warnings[0]).toContain('HTTP 500')
  })

  it('falls back to the cached index on a network failure', async () => {
    const cache = await seededCache()
    const client = new RegistryClient({
      cache,
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new TypeError('offline')
      }),
      now,
    })

    const snapshot = await client.fetch()

    expect(snapshot.source).toBe('cache')
    expect(snapshot.stale).toBe(true)
    expect(snapshot.index).toEqual(makeRegistryIndex())
  })

  it('falls back to the cached index on a timeout', async () => {
    const cache = await seededCache()
    const client = new RegistryClient({
      cache,
      fetchImpl: hangingFetch(),
      timeoutMs: 10,
      now,
    })

    const snapshot = await client.fetch()

    expect(snapshot.source).toBe('cache')
    expect(snapshot.warnings[0]).toContain('timed out')
  })

  it('does not hide malformed remote data behind the cache', async () => {
    const cache = await seededCache()
    const client = new RegistryClient({
      cache,
      fetchImpl: vi.fn<typeof fetch>(
        async () => new Response('not json', { status: 200 }),
      ),
      now,
    })

    const error = await clientError(() => client.fetch())
    expect(error.code).toBe('E_REGISTRY_PARSE')
  })

  it('does not fall back to cache for an unsupported schema version', async () => {
    const cache = await seededCache()
    const client = new RegistryClient({
      cache,
      fetchImpl: vi.fn<typeof fetch>(async () =>
        jsonResponse({ ...makeRegistryIndex(), schemaVersion: 2 }),
      ),
      now,
    })

    const error = await clientError(() => client.fetch())
    expect(error.code).toBe('E_REGISTRY_SCHEMA_VERSION')
  })

  it('rejects oversized responses', async () => {
    const client = new RegistryClient({
      maxBytes: 16,
      fetchImpl: vi.fn<typeof fetch>(async () =>
        jsonResponse(makeRegistryIndex()),
      ),
      now,
    })

    const error = await clientError(() => client.fetch())
    expect(error.code).toBe('E_REGISTRY_TOO_LARGE')
  })

  it('throws the network error when no cache exists', async () => {
    const client = new RegistryClient({
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new TypeError('offline')
      }),
      now,
    })

    const error = await clientError(() => client.fetch())
    expect(error.code).toBe('E_REGISTRY_NETWORK')
  })

  it('honours allowCache: false', async () => {
    const cache = await seededCache()
    const client = new RegistryClient({
      cache,
      fetchImpl: vi.fn<typeof fetch>(
        async () => new Response('boom', { status: 503 }),
      ),
      now,
    })

    const error = await clientError(() => client.fetch({ allowCache: false }))
    expect(error.code).toBe('E_REGISTRY_HTTP')
  })

  it('warns when the fetched index could not be cached', async () => {
    const directory = await cachePath()
    const blocker = path.join(path.dirname(directory), 'blocker')
    await writeFile(blocker, 'not a directory', 'utf8')
    const cache = new RegistryCache(path.join(blocker, 'registry-cache.json'))
    const client = new RegistryClient({
      cache,
      fetchImpl: vi.fn<typeof fetch>(async () =>
        jsonResponse(makeRegistryIndex()),
      ),
      now,
    })

    const snapshot = await client.fetch()

    expect(snapshot.source).toBe('network')
    expect(snapshot.warnings[0]).toContain('cache could not be updated')
  })

  it('refuses a cache that belongs to another registry URL', async () => {
    const cache = new RegistryCache(await cachePath())
    await cache.write({
      sourceUrl:
        'https://raw.githubusercontent.com/kino14910/other-repo/main/registry/index.json',
      fetchedAt: cachedFetchedAt,
      index: makeRegistryIndex(),
    })
    const client = new RegistryClient({
      cache,
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new TypeError('offline')
      }),
      now,
    })

    const error = await clientError(() => client.fetch())
    expect(error.code).toBe('E_REGISTRY_NETWORK')
  })

  it('reports an unusable cache alongside the network error', async () => {
    const cache = new RegistryCache(await cachePath())
    await writeFile(cache.filePath, '{"version":1', 'utf8')
    const client = new RegistryClient({
      cache,
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new TypeError('offline')
      }),
      now,
    })

    const error = await clientError(() => client.fetch())
    expect(error.code).toBe('E_REGISTRY_NETWORK')
    expect(error.message).toContain('cached index is unusable')
  })

  it('cancels before starting a request when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(makeRegistryIndex()),
    )
    const client = new RegistryClient({ fetchImpl, now })

    const error = await clientError(() =>
      client.fetch({ signal: controller.signal }),
    )
    expect(error.code).toBe('E_REGISTRY_CANCELLED')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
