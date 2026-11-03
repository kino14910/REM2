import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ElectronAppSettingsStore } from '@/host/electron/app-settings-store.js'

function readSettings(directory: string): unknown {
  return JSON.parse(readFileSync(path.join(directory, 'settings.json'), 'utf8'))
}

describe('unit · app settings document', () => {
  let root: string | undefined

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  function prepareRoot(): string {
    root = mkdtempSync(path.join(tmpdir(), 'rem2-settings-'))
    return root
  }

  it('defaults to system proxy and system color mode when no file exists', async () => {
    const directory = prepareRoot()
    const store = new ElectronAppSettingsStore(directory)
    await store.load()
    expect(store.getProxy()).toEqual({ mode: 'system' })
    expect(store.getAppearance()).toEqual({ colorMode: 'system' })
    expect(existsSync(path.join(directory, 'settings.json'))).toBe(false)
  })

  it('seeds the unified document on the first write and keeps namespaces isolated', async () => {
    const directory = prepareRoot()
    const store = new ElectronAppSettingsStore(directory)
    await store.load()

    await store.setProxy({
      mode: 'manual',
      address: '127.0.0.1:7890',
      bypass: 'localhost',
    })
    expect(readSettings(directory)).toEqual({
      schemaVersion: 1,
      proxy: {
        mode: 'manual',
        address: 'http://127.0.0.1:7890',
        bypass: 'localhost',
      },
      appearance: { colorMode: 'system' },
    })

    await store.setAppearance({ colorMode: 'dark' })
    expect(readSettings(directory)).toEqual({
      schemaVersion: 1,
      proxy: {
        mode: 'manual',
        address: 'http://127.0.0.1:7890',
        bypass: 'localhost',
      },
      appearance: { colorMode: 'dark' },
    })

    await store.setProxy({ mode: 'direct' })
    expect(readSettings(directory)).toEqual({
      schemaVersion: 1,
      proxy: { mode: 'direct' },
      appearance: { colorMode: 'dark' },
    })
  })

  it('restores both namespaces in a fresh store', async () => {
    const directory = prepareRoot()
    const first = new ElectronAppSettingsStore(directory)
    await first.load()
    await first.setProxy({
      mode: 'manual',
      address: 'https://proxy.local:8443',
      bypass: 'localhost',
    })
    await first.setAppearance({ colorMode: 'light' })

    const second = new ElectronAppSettingsStore(directory)
    await second.load()
    expect(second.getProxy()).toEqual({
      mode: 'manual',
      address: 'https://proxy.local:8443',
      bypass: 'localhost',
    })
    expect(second.getAppearance()).toEqual({ colorMode: 'light' })
  })

  it('never persists the runtime resolved diagnostic', async () => {
    const directory = prepareRoot()
    const store = new ElectronAppSettingsStore(directory)
    await store.load()
    await store.setProxy({
      mode: 'manual',
      address: '127.0.0.1:7890',
      resolved: 'PROXY 127.0.0.1:7890',
    })
    const document = readSettings(directory) as {
      proxy: Record<string, unknown>
    }
    expect(document.proxy).toEqual({
      mode: 'manual',
      address: 'http://127.0.0.1:7890',
    })
  })

  it('imports valid legacy proxy and appearance files once', async () => {
    const directory = prepareRoot()
    writeFileSync(
      path.join(directory, 'proxy-settings.json'),
      JSON.stringify({
        version: 1,
        proxy: {
          mode: 'manual',
          address: '127.0.0.1:7890',
          bypass: 'localhost',
        },
      }),
      'utf8',
    )
    writeFileSync(
      path.join(directory, 'appearance-settings.json'),
      JSON.stringify({ version: 1, colorMode: 'dark' }),
      'utf8',
    )

    const store = new ElectronAppSettingsStore(directory)
    await store.load()
    expect(store.getProxy()).toEqual({
      mode: 'manual',
      address: 'http://127.0.0.1:7890',
      bypass: 'localhost',
    })
    expect(store.getAppearance()).toEqual({ colorMode: 'dark' })
    expect(readSettings(directory)).toEqual({
      schemaVersion: 1,
      proxy: {
        mode: 'manual',
        address: 'http://127.0.0.1:7890',
        bypass: 'localhost',
      },
      appearance: { colorMode: 'dark' },
    })
    expect(existsSync(path.join(directory, 'proxy-settings.json'))).toBe(true)
    expect(existsSync(path.join(directory, 'appearance-settings.json'))).toBe(
      true,
    )

    await store.setAppearance({ colorMode: 'light' })
    const restarted = new ElectronAppSettingsStore(directory)
    await restarted.load()
    expect(restarted.getAppearance()).toEqual({ colorMode: 'light' })
    expect(restarted.getProxy()).toEqual(store.getProxy())
  })

  it('does not re-import legacy files over an existing settings.json', async () => {
    const directory = prepareRoot()
    writeFileSync(
      path.join(directory, 'proxy-settings.json'),
      JSON.stringify({ version: 1, proxy: { mode: 'direct' } }),
      'utf8',
    )
    writeFileSync(
      path.join(directory, 'appearance-settings.json'),
      JSON.stringify({ version: 1, colorMode: 'dark' }),
      'utf8',
    )
    writeFileSync(
      path.join(directory, 'settings.json'),
      JSON.stringify({
        schemaVersion: 1,
        proxy: { mode: 'system' },
        appearance: { colorMode: 'light' },
      }),
      'utf8',
    )

    const store = new ElectronAppSettingsStore(directory)
    await store.load()
    expect(store.getProxy()).toEqual({ mode: 'system' })
    expect(store.getAppearance()).toEqual({ colorMode: 'light' })
    expect(readSettings(directory)).toEqual({
      schemaVersion: 1,
      proxy: { mode: 'system' },
      appearance: { colorMode: 'light' },
    })
  })

  it('imports the valid side when the other legacy file is missing', async () => {
    const directory = prepareRoot()
    writeFileSync(
      path.join(directory, 'proxy-settings.json'),
      JSON.stringify({ version: 1, proxy: { mode: 'direct' } }),
      'utf8',
    )

    const store = new ElectronAppSettingsStore(directory)
    await store.load()
    expect(store.getProxy()).toEqual({ mode: 'direct' })
    expect(store.getAppearance()).toEqual({ colorMode: 'system' })
  })

  it('imports the valid side when the other legacy file is corrupt', async () => {
    const directory = prepareRoot()
    const corrupt = '{"version":1'
    writeFileSync(path.join(directory, 'proxy-settings.json'), corrupt, 'utf8')
    writeFileSync(
      path.join(directory, 'appearance-settings.json'),
      JSON.stringify({ version: 1, colorMode: 'dark' }),
      'utf8',
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const store = new ElectronAppSettingsStore(directory)
    await store.load()
    expect(store.getProxy()).toEqual({ mode: 'system' })
    expect(store.getAppearance()).toEqual({ colorMode: 'dark' })
    expect(errorSpy).toHaveBeenCalled()
    expect(
      readFileSync(path.join(directory, 'proxy-settings.json'), 'utf8'),
    ).toBe(corrupt)
    errorSpy.mockRestore()
  })

  it('ignores an unsupported legacy version without deleting it', async () => {
    const directory = prepareRoot()
    const legacy = JSON.stringify({
      version: 2,
      proxy: { mode: 'direct' },
    })
    writeFileSync(path.join(directory, 'proxy-settings.json'), legacy, 'utf8')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const store = new ElectronAppSettingsStore(directory)
    await store.load()
    expect(store.getProxy()).toEqual({ mode: 'system' })
    expect(
      readFileSync(path.join(directory, 'proxy-settings.json'), 'utf8'),
    ).toBe(legacy)
    errorSpy.mockRestore()
  })

  it.each([
    ['bad JSON', '{"schemaVersion":1'],
    [
      'unknown future version',
      JSON.stringify({
        schemaVersion: 2,
        proxy: { mode: 'system' },
        appearance: { colorMode: 'system' },
      }),
    ],
    ['missing proxy', JSON.stringify({ schemaVersion: 1 })],
    [
      'missing appearance',
      JSON.stringify({ schemaVersion: 1, proxy: { mode: 'system' } }),
    ],
    [
      'invalid proxy value',
      JSON.stringify({
        schemaVersion: 1,
        proxy: { mode: 'auto' },
        appearance: { colorMode: 'system' },
      }),
    ],
    [
      'invalid appearance value',
      JSON.stringify({
        schemaVersion: 1,
        proxy: { mode: 'system' },
        appearance: { colorMode: 'sepia' },
      }),
    ],
  ])('rejects %s and keeps the file untouched', async (_label, text) => {
    const directory = prepareRoot()
    const file = path.join(directory, 'settings.json')
    writeFileSync(file, text, 'utf8')

    const store = new ElectronAppSettingsStore(directory)
    await expect(store.load()).rejects.toMatchObject({
      code: 'E_SETTINGS_INVALID',
    })
    expect(store.getProxy()).toEqual({ mode: 'system' })
    expect(store.getAppearance()).toEqual({ colorMode: 'system' })
    expect(readFileSync(file, 'utf8')).toBe(text)
  })

  it('preserves a damaged file before the first successful write', async () => {
    const directory = prepareRoot()
    const file = path.join(directory, 'settings.json')
    const original = JSON.stringify({
      schemaVersion: 2,
      proxy: { mode: 'direct' },
      appearance: { colorMode: 'dark' },
    })
    writeFileSync(file, original, 'utf8')

    const store = new ElectronAppSettingsStore(directory)
    await expect(store.load()).rejects.toMatchObject({
      code: 'E_SETTINGS_INVALID',
    })
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(
      readdirSync(directory).filter(name =>
        name.startsWith('settings.invalid-'),
      ),
    ).toEqual([])

    await store.setAppearance({ colorMode: 'light' })
    expect(readSettings(directory)).toEqual({
      schemaVersion: 1,
      proxy: { mode: 'system' },
      appearance: { colorMode: 'light' },
    })
    const backup = readdirSync(directory).find(name =>
      name.startsWith('settings.invalid-'),
    )
    expect(backup).toBeDefined()
    expect(readFileSync(path.join(directory, backup!), 'utf8')).toBe(original)
  })

  it('updates one namespace without dropping unrelated top-level keys', async () => {
    const directory = prepareRoot()
    const file = path.join(directory, 'settings.json')
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        proxy: { mode: 'system' },
        appearance: { colorMode: 'dark' },
        future: { note: 'kept' },
      }),
      'utf8',
    )

    const store = new ElectronAppSettingsStore(directory)
    await store.load()
    await store.setProxy({ mode: 'direct' })
    expect(readSettings(directory)).toMatchObject({
      schemaVersion: 1,
      proxy: { mode: 'direct' },
      appearance: { colorMode: 'dark' },
      future: { note: 'kept' },
    })
  })
})
