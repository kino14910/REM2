import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ElectronAppSettingsStore } from '@/host/electron/app-settings-store.js'
import { normalizeAppearanceSettings } from '@/host/settings/appearance-settings.js'

function settingsPath(directory: string): string {
  return path.join(directory, 'settings.json')
}

describe('unit · appearance settings', () => {
  let root: string | undefined

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  function prepareRoot(): string {
    root = mkdtempSync(path.join(tmpdir(), 'rem2-appearance-'))
    return root
  }

  it('defaults to following the system when the file is missing', async () => {
    const store = new ElectronAppSettingsStore(prepareRoot())
    await store.load()
    expect(store.getAppearance()).toEqual({ colorMode: 'system' })
  })

  it('persists the color mode and reloads it in a fresh store', async () => {
    const directory = prepareRoot()
    const first = new ElectronAppSettingsStore(directory)
    await first.load()
    await first.setAppearance({ colorMode: 'dark' })

    expect(first.getAppearance()).toEqual({ colorMode: 'dark' })
    expect(JSON.parse(readFileSync(settingsPath(directory), 'utf8'))).toEqual({
      schemaVersion: 1,
      proxy: { mode: 'system' },
      appearance: { colorMode: 'dark' },
    })

    const second = new ElectronAppSettingsStore(directory)
    await second.load()
    expect(second.getAppearance()).toEqual({ colorMode: 'dark' })
  })

  it.each([
    ['bad JSON', '{"schemaVersion":1'],
    [
      'bad version',
      JSON.stringify({
        schemaVersion: 2,
        proxy: { mode: 'system' },
        appearance: { colorMode: 'dark' },
      }),
    ],
    [
      'missing colorMode',
      JSON.stringify({
        schemaVersion: 1,
        proxy: { mode: 'system' },
        appearance: {},
      }),
    ],
    [
      'invalid colorMode',
      JSON.stringify({
        schemaVersion: 1,
        proxy: { mode: 'system' },
        appearance: { colorMode: 'sepia' },
      }),
    ],
  ])('rejects %s', async (_label, text) => {
    const directory = prepareRoot()
    writeFileSync(settingsPath(directory), text, 'utf8')
    const store = new ElectronAppSettingsStore(directory)
    await expect(store.load()).rejects.toThrow()
  })

  it('normalizes untrusted settings before they are stored', () => {
    expect(normalizeAppearanceSettings({ colorMode: 'light' })).toEqual({
      colorMode: 'light',
    })
    expect(() => normalizeAppearanceSettings({ colorMode: 'sepia' })).toThrow()
    expect(() => normalizeAppearanceSettings(null)).toThrow()
  })
})
