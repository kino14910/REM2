import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { RegistryCache } from '@/host/registry/cache.js'
import { DEFAULT_REGISTRY_URL } from '@/host/registry/client.js'
import { RegistryClientError } from '@/host/registry/errors.js'

import { makeRegistryIndex } from '../helpers/registry-index.js'

const fetchedAt = '2026-11-04T06:30:00.000Z'

describe('unit · registry cache', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  async function cachePath(): Promise<string> {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-registry-cache-'))
    return path.join(root, 'registry-cache.json')
  }

  it('treats a missing file as a cache miss', async () => {
    const cache = new RegistryCache(await cachePath())
    await expect(cache.read(DEFAULT_REGISTRY_URL)).resolves.toEqual({
      status: 'miss',
    })
  })

  it('writes and reads back the last successful index', async () => {
    const file = await cachePath()
    const cache = new RegistryCache(file)
    const index = makeRegistryIndex()
    await cache.write({
      sourceUrl: DEFAULT_REGISTRY_URL,
      fetchedAt,
      index,
    })

    await expect(cache.read(DEFAULT_REGISTRY_URL)).resolves.toEqual({
      status: 'hit',
      entry: { sourceUrl: DEFAULT_REGISTRY_URL, fetchedAt, index },
    })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      sourceUrl: DEFAULT_REGISTRY_URL,
      fetchedAt,
      index,
    })
  })

  it('refuses a cache belonging to another registry URL', async () => {
    const cache = new RegistryCache(await cachePath())
    await cache.write({
      sourceUrl: DEFAULT_REGISTRY_URL,
      fetchedAt,
      index: makeRegistryIndex(),
    })

    await expect(
      cache.read(
        'https://raw.githubusercontent.com/kino14910/other-repo/main/registry/index.json',
      ),
    ).resolves.toEqual({ status: 'miss' })
  })

  it('reports corrupt JSON without deleting the file', async () => {
    const file = await cachePath()
    await writeFile(file, '{"version":1', 'utf8')
    const cache = new RegistryCache(file)

    const result = await cache.read(DEFAULT_REGISTRY_URL)
    expect(result.status).toBe('invalid')
    expect(await readFile(file, 'utf8')).toBe('{"version":1')
  })

  it('reports an unsupported cache envelope version', async () => {
    const file = await cachePath()
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        sourceUrl: DEFAULT_REGISTRY_URL,
        fetchedAt,
        index: makeRegistryIndex(),
      }),
      'utf8',
    )
    const result = await new RegistryCache(file).read(DEFAULT_REGISTRY_URL)
    expect(result.status).toBe('invalid')
  })

  it('reports an invalid cached index', async () => {
    const file = await cachePath()
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        sourceUrl: DEFAULT_REGISTRY_URL,
        fetchedAt,
        index: { ...makeRegistryIndex(), schemaVersion: 2 },
      }),
      'utf8',
    )
    const result = await new RegistryCache(file).read(DEFAULT_REGISTRY_URL)
    expect(result.status).toBe('invalid')
    if (result.status === 'invalid') {
      expect(result.reason).toContain('E_REGISTRY_SCHEMA_VERSION')
    }
  })

  it('rejects a cache path that is not a regular file', async () => {
    const file = await cachePath()
    await mkdir(file)
    const result = await new RegistryCache(file).read(DEFAULT_REGISTRY_URL)
    expect(result.status).toBe('invalid')
  })

  it('validates inputs before writing', async () => {
    const cache = new RegistryCache(await cachePath())
    await expect(
      cache.write({
        sourceUrl: 'not a URL',
        fetchedAt,
        index: makeRegistryIndex(),
      }),
    ).rejects.toThrow(RegistryClientError)

    await expect(
      cache.write({
        sourceUrl: DEFAULT_REGISTRY_URL,
        fetchedAt: 'yesterday',
        index: makeRegistryIndex(),
      }),
    ).rejects.toThrow(RegistryClientError)
  })

  it('wraps write failures as cache errors', async () => {
    const directory = await cachePath()
    const blocker = path.join(path.dirname(directory), 'blocker')
    await writeFile(blocker, 'not a directory', 'utf8')
    const cache = new RegistryCache(path.join(blocker, 'registry-cache.json'))

    try {
      await cache.write({
        sourceUrl: DEFAULT_REGISTRY_URL,
        fetchedAt,
        index: makeRegistryIndex(),
      })
      throw new Error('expected a cache write failure')
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryClientError)
      if (error instanceof RegistryClientError) {
        expect(error.code).toBe('E_REGISTRY_CACHE')
      }
    }
  })

  it('replaces an older entry atomically', async () => {
    const file = await cachePath()
    const cache = new RegistryCache(file)
    await cache.write({
      sourceUrl: DEFAULT_REGISTRY_URL,
      fetchedAt,
      index: makeRegistryIndex({ generatedAt: '2026-11-01T00:00:00.000Z' }),
    })
    await cache.write({
      sourceUrl: DEFAULT_REGISTRY_URL,
      fetchedAt,
      index: makeRegistryIndex({ generatedAt: '2026-11-04T00:00:00.000Z' }),
    })

    const result = await cache.read(DEFAULT_REGISTRY_URL)
    expect(result.status).toBe('hit')
    if (result.status === 'hit') {
      expect(result.entry.index.generatedAt).toBe('2026-11-04T00:00:00.000Z')
    }
  })
})
