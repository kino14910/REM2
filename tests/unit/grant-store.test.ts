import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginGrantStore } from '../../src/host/plugins/grant-store.js'

describe('unit · plugin grant store', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  async function grantsPath(): Promise<string> {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-grants-'))
    return path.join(root, 'plugin-grants.json')
  }

  it('treats a missing file as no grants', async () => {
    const store = new PluginGrantStore(await grantsPath())
    await store.load()
    expect(store.entries()).toEqual({})
    expect(store.get('com.example.plugin')).toEqual([])
  })

  it('persists additive grants and reloads them in a fresh store', async () => {
    const file = await grantsPath()
    const first = new PluginGrantStore(file)
    await first.load()
    await first.set('com.example.plugin', ['ui.panel'])
    await first.set('com.example.plugin', ['ui.theme', 'ui.route'])

    expect(first.get('com.example.plugin')).toEqual([
      'ui.panel',
      'ui.route',
      'ui.theme',
    ])

    const second = new PluginGrantStore(file)
    await second.load()
    expect(second.get('com.example.plugin')).toEqual([
      'ui.panel',
      'ui.route',
      'ui.theme',
    ])
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      entries: {
        'com.example.plugin': ['ui.panel', 'ui.route', 'ui.theme'],
      },
    })
  })

  it('removes a plugin entry on uninstall', async () => {
    const file = await grantsPath()
    const store = new PluginGrantStore(file)
    await store.load()
    await store.set('com.example.plugin', ['ui.panel'])
    await store.remove('com.example.plugin')
    expect(store.entries()).toEqual({})
  })

  it.each([
    ['bad JSON', '{"version":1'],
    ['invalid id', '{"version":1,"entries":{"../escape":["ui.panel"]}}'],
    ['empty capability list', '{"version":1,"entries":{"com.example.plugin":[]}}'],
    [
      'invalid capability',
      JSON.stringify({
        version: 1,
        entries: { 'com.example.plugin': ['UI Panel'] },
      }),
    ],
    [
      'duplicate capability',
      JSON.stringify({
        version: 1,
        entries: { 'com.example.plugin': ['ui.panel', 'ui.panel'] },
      }),
    ],
  ])('rejects %s', async (_label, text) => {
    const file = await grantsPath()
    await writeFile(file, text, 'utf8')
    const store = new PluginGrantStore(file)
    await expect(store.load()).rejects.toMatchObject({
      code: 'E_STATE_INVALID',
    })
  })

  it('rejects invalid input without touching the file', async () => {
    const file = await grantsPath()
    const store = new PluginGrantStore(file)
    await store.load()
    await expect(store.set('com.example.plugin', [])).rejects.toMatchObject({
      code: 'E_STATE_INVALID',
    })
    await expect(
      store.set('com.example.plugin', ['ui.panel', 'ui.panel']),
    ).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
  })
})
