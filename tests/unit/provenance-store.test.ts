import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PluginProvenanceStore,
  type PluginProvenance,
} from '../../src/host/plugins/provenance-store.js'

const validEntry: PluginProvenance = {
  kind: 'remote',
  url: 'https://github.com/example/plugin/releases/download/v1.0.0/plugin.zip',
  sha256: 'a'.repeat(64),
  publishedAt: '2026-01-02T03:04:05Z',
  installedAt: '2026-01-03T03:04:05Z',
}

describe('unit · plugin provenance store', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  async function provenancePath(): Promise<string> {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-provenance-'))
    return path.join(root, 'plugin-provenance.json')
  }

  it('treats a missing file as empty', async () => {
    const store = new PluginProvenanceStore(await provenancePath())
    await store.load()
    expect(store.entries()).toEqual({})
    expect(store.get('com.example.plugin')).toBeUndefined()
  })

  it('persists entries and reloads them in a fresh store', async () => {
    const file = await provenancePath()
    const first = new PluginProvenanceStore(file)
    await first.load()
    await first.set('com.example.plugin', validEntry)

    const second = new PluginProvenanceStore(file)
    await second.load()
    expect(second.get('com.example.plugin')).toEqual(validEntry)
    expect(second.entries()).toEqual({ 'com.example.plugin': validEntry })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      entries: { 'com.example.plugin': validEntry },
    })
  })

  it.each([
    ['bad JSON', '{"version":1'],
    ['invalid id', '{"version":1,"entries":{"../escape":{}}}'],
    [
      'bad URL',
      JSON.stringify({
        version: 1,
        entries: {
          'com.example.plugin': {
            ...validEntry,
            url: 'http://example.com/a.zip',
          },
        },
      }),
    ],
    [
      'bad digest',
      JSON.stringify({
        version: 1,
        entries: {
          'com.example.plugin': { ...validEntry, sha256: 'not-a-digest' },
        },
      }),
    ],
    ['wrong version', JSON.stringify({ version: 2, entries: {} })],
  ])('rejects corrupt persisted state (%s)', async (_label, text) => {
    const file = await provenancePath()
    await writeFile(file, text, 'utf8')
    const store = new PluginProvenanceStore(file)
    await expect(store.load()).rejects.toMatchObject({
      code: 'E_STATE_INVALID',
    })
  })

  it('validates ids and entries passed to set', async () => {
    const store = new PluginProvenanceStore(await provenancePath())
    await store.load()
    await expect(store.set('../escape', validEntry)).rejects.toMatchObject({
      code: 'E_STATE_INVALID',
    })
    await expect(
      store.set('com.example.plugin', { ...validEntry, sha256: 'bad' }),
    ).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
    expect(store.entries()).toEqual({})
  })

  it('rolls back memory when persistence fails', async () => {
    const file = await provenancePath()
    const store = new PluginProvenanceStore(file)
    await store.load()
    await mkdir(file)
    await expect(
      store.set('com.example.plugin', validEntry),
    ).rejects.toMatchObject({ code: 'E_STATE_WRITE' })
    expect(store.get('com.example.plugin')).toBeUndefined()
    expect(store.entries()).toEqual({})
  })

  it('removes entries and treats missing ids idempotently', async () => {
    const file = await provenancePath()
    const store = new PluginProvenanceStore(file)
    await store.load()
    await store.set('com.example.plugin', validEntry)
    await store.remove('com.example.plugin')
    await store.remove('com.example.plugin')

    const reloaded = new PluginProvenanceStore(file)
    await reloaded.load()
    expect(reloaded.entries()).toEqual({})
  })
})
