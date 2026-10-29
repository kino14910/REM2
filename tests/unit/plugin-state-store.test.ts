import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginStateStore } from '../../src/host/plugins/state-store.js'

describe('unit · plugin state store', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  async function statePath(): Promise<string> {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-state-'))
    return path.join(root, 'plugin-manager.json')
  }

  it('missing state means nothing is disabled', async () => {
    const store = new PluginStateStore(await statePath())
    await store.load()
    expect(store.ids()).toEqual([])
    expect(store.isDisabled('com.example.plugin')).toBe(false)
  })

  it('atomic writes persist disabled ids and survive a fresh store', async () => {
    const file = await statePath()
    const first = new PluginStateStore(file)
    await first.load()
    expect(await first.setDisabled('com.example.plugin', true)).toBe(true)
    expect(await first.setDisabled('com.example.plugin', true)).toBe(false)
    expect(await first.setDisabled('com.example.other', true)).toBe(true)
    expect(await first.setDisabled('com.example.other', false)).toBe(true)

    const second = new PluginStateStore(file)
    await second.load()
    expect(second.ids()).toEqual(['com.example.plugin'])
    const persisted = JSON.parse(await readFile(file, 'utf8')) as {
      version: number
      disabled: string[]
    }
    expect(persisted).toEqual({ version: 1, disabled: ['com.example.plugin'] })
    expect(
      (await readdir(root!)).filter(name => name.endsWith('.tmp')),
    ).toEqual([])
  })

  it('invalid ids are rejected before persistence', async () => {
    const store = new PluginStateStore(await statePath())
    await store.load()
    await expect(store.setDisabled('../escape', true)).rejects.toMatchObject({
      code: 'E_INVALID_ID',
    })
  })

  it.each([
    ['malformed JSON', '{"version":1'],
    ['wrong version', '{"version":2,"disabled":[]}'],
    ['invalid id', '{"version":1,"disabled":["../escape"]}'],
    [
      'duplicate ids',
      '{"version":1,"disabled":["com.example.a","com.example.a"]}',
    ],
  ])(
    'corrupt state (%s) is rejected instead of silently enabling everything',
    async (_label, text) => {
      const file = await statePath()
      await writeFile(file, text, 'utf8')
      const store = new PluginStateStore(file)
      await expect(store.load()).rejects.toMatchObject({
        code: 'E_STATE_INVALID',
      })
    },
  )
})
