import type { Session } from 'electron'

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ElectronAppSettingsStore } from '@/host/electron/app-settings-store.js'
import { ElectronProxySettingsService } from '@/host/electron/proxy-settings-service.js'
import {
  normalizeProxySettings,
  parseProxyAddress,
  type ProxyConfigLike,
  ProxySettingsError,
  toProxyConfig,
} from '@/host/settings/proxy-settings.js'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function settingsPath(directory: string): string {
  return path.join(directory, 'settings.json')
}

function readPersistedProxy(directory: string): unknown {
  return (
    JSON.parse(readFileSync(settingsPath(directory), 'utf8')) as {
      proxy: unknown
    }
  ).proxy
}

describe('unit · proxy settings', () => {
  let root: string | undefined

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  function prepareRoot(): string {
    root = mkdtempSync(path.join(tmpdir(), 'rem2-proxy-'))
    return root
  }

  it('defaults to the system proxy when the file is missing', async () => {
    const store = new ElectronAppSettingsStore(prepareRoot())
    await store.load()
    expect(store.getProxy()).toEqual({ mode: 'system' })
  })

  it('persists manual settings and reloads them in a fresh store', async () => {
    const directory = prepareRoot()
    const first = new ElectronAppSettingsStore(directory)
    await first.load()
    await first.setProxy({
      mode: 'manual',
      address: 'http://127.0.0.1:7890',
      bypass: 'localhost,127.0.0.1',
    })

    expect(first.getProxy()).toEqual({
      mode: 'manual',
      address: 'http://127.0.0.1:7890',
      bypass: 'localhost,127.0.0.1',
    })
    expect(JSON.parse(readFileSync(settingsPath(directory), 'utf8'))).toEqual({
      schemaVersion: 1,
      proxy: {
        mode: 'manual',
        address: 'http://127.0.0.1:7890',
        bypass: 'localhost,127.0.0.1',
      },
      appearance: { colorMode: 'system' },
      logging: { enabled: true, level: 'info' },
    })

    const second = new ElectronAppSettingsStore(directory)
    await second.load()
    expect(second.getProxy()).toEqual(first.getProxy())
  })

  it('loads persisted manual addresses without a scheme as http', async () => {
    const directory = prepareRoot()
    writeFileSync(
      settingsPath(directory),
      JSON.stringify({
        schemaVersion: 1,
        proxy: { mode: 'manual', address: '127.0.0.1:7890' },
        appearance: { colorMode: 'system' },
      }),
      'utf8',
    )
    const store = new ElectronAppSettingsStore(directory)
    await store.load()
    expect(store.getProxy()).toEqual({
      mode: 'manual',
      address: 'http://127.0.0.1:7890',
    })
  })

  it('drops the manual address when switching to direct', async () => {
    const directory = prepareRoot()
    const store = new ElectronAppSettingsStore(directory)
    await store.load()
    await store.setProxy({ mode: 'manual', address: '127.0.0.1:7890' })
    await store.setProxy({ mode: 'direct', address: '127.0.0.1:7890' })
    expect(store.getProxy()).toEqual({ mode: 'direct' })
    expect(readPersistedProxy(directory)).toEqual({ mode: 'direct' })
  })

  it.each([
    ['bad JSON', '{"schemaVersion":1'],
    [
      'bad version',
      JSON.stringify({
        schemaVersion: 2,
        proxy: { mode: 'system' },
        appearance: { colorMode: 'system' },
      }),
    ],
    [
      'missing proxy',
      JSON.stringify({
        schemaVersion: 1,
        appearance: { colorMode: 'system' },
      }),
    ],
    [
      'invalid mode',
      JSON.stringify({
        schemaVersion: 1,
        proxy: { mode: 'auto' },
        appearance: { colorMode: 'system' },
      }),
    ],
    [
      'manual without address',
      JSON.stringify({
        schemaVersion: 1,
        proxy: { mode: 'manual' },
        appearance: { colorMode: 'system' },
      }),
    ],
    [
      'invalid bypass type',
      JSON.stringify({
        schemaVersion: 1,
        proxy: {
          mode: 'manual',
          address: '127.0.0.1:7890',
          bypass: 1,
        },
        appearance: { colorMode: 'system' },
      }),
    ],
  ])('rejects %s', async (_label, text) => {
    const directory = prepareRoot()
    writeFileSync(settingsPath(directory), text, 'utf8')
    const store = new ElectronAppSettingsStore(directory)
    await expect(store.load()).rejects.toMatchObject({
      code: 'E_SETTINGS_INVALID',
    })
  })

  it.each([
    ['127.0.0.1:7890', 'http', '127.0.0.1', 7890],
    ['http://127.0.0.1:7890', 'http', '127.0.0.1', 7890],
    ['https://proxy.local', 'https', 'proxy.local', 443],
    ['http://proxy.local', 'http', 'proxy.local', 80],
  ])('parses %s', (input, scheme, host, port) => {
    expect(parseProxyAddress(input)).toEqual({ scheme, host, port })
  })

  it.each([
    '',
    'ftp://proxy.local:21',
    'http://user:secret@proxy.local:8080',
    'http://proxy.local:8080/path',
    'http://proxy.local:8080?query',
    'http://proxy.local:0',
    'http://proxy.local:70000',
  ])('rejects invalid address %j', input => {
    expect(() => parseProxyAddress(input)).toThrow(ProxySettingsError)
  })

  it('maps every mode to the Electron proxy config subset', () => {
    expect(toProxyConfig({ mode: 'system' })).toEqual({ mode: 'system' })
    expect(toProxyConfig({ mode: 'direct' })).toEqual({ mode: 'direct' })
    expect(
      toProxyConfig({
        mode: 'manual',
        address: '127.0.0.1:7890',
        bypass: 'localhost',
      }),
    ).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'http=http://127.0.0.1:7890;https=http://127.0.0.1:7890',
      proxyBypassRules: 'localhost',
    })
  })

  it('preserves an https proxy scheme in the Electron proxy rules', () => {
    expect(
      toProxyConfig({
        mode: 'manual',
        address: 'https://proxy.local:8443',
      }),
    ).toEqual({
      mode: 'fixed_servers',
      proxyRules:
        'http=https://proxy.local:8443;https=https://proxy.local:8443',
    })
  })

  it('normalizes untrusted settings before they are stored', () => {
    expect(
      normalizeProxySettings({
        mode: 'manual',
        address: ' https://proxy.local:8443 ',
        bypass: '  localhost  ',
      }),
    ).toEqual({
      mode: 'manual',
      address: 'https://proxy.local:8443',
      bypass: 'localhost',
    })
  })

  it('initialize loads the persisted proxy before applying it', async () => {
    const directory = prepareRoot()
    writeFileSync(
      settingsPath(directory),
      JSON.stringify({
        schemaVersion: 1,
        proxy: { mode: 'manual', address: '127.0.0.1:7890' },
        appearance: { colorMode: 'system' },
      }),
      'utf8',
    )
    const store = new ElectronAppSettingsStore(directory)
    const setProxy = vi.fn(async (_config: ProxyConfigLike) => {})
    const session = {
      setProxy,
      resolveProxy: vi.fn(async () => 'DIRECT'),
    } as unknown as Session
    const service = new ElectronProxySettingsService(session, store)

    await service.initialize()
    expect(setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http=http://127.0.0.1:7890;https=http://127.0.0.1:7890',
    })
    expect(store.getProxy()).toEqual({
      mode: 'manual',
      address: 'http://127.0.0.1:7890',
    })
  })

  it('keeps the service usable when settings.json is damaged at startup', async () => {
    const directory = prepareRoot()
    const file = settingsPath(directory)
    writeFileSync(file, '{"schemaVersion":1', 'utf8')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = new ElectronAppSettingsStore(directory)
      const setProxy = vi.fn(async (_config: ProxyConfigLike) => {})
      const session = {
        setProxy,
        resolveProxy: vi.fn(async () => 'DIRECT'),
      } as unknown as Session
      const service = new ElectronProxySettingsService(session, store)

      // 启动不失败：损坏的文件回落为系统代理，随后仍能正常读写
      await service.initialize()
      expect(setProxy).toHaveBeenCalledWith({ mode: 'system' })
      expect(store.getProxy()).toEqual({ mode: 'system' })

      const result = await service.set({
        mode: 'manual',
        address: '127.0.0.1:7890',
      })
      expect(result).toMatchObject({
        mode: 'manual',
        address: 'http://127.0.0.1:7890',
        resolved: 'DIRECT',
      })
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        schemaVersion: 1,
        proxy: { mode: 'manual', address: 'http://127.0.0.1:7890' },
        appearance: { colorMode: 'system' },
        logging: { enabled: true, level: 'info' },
      })
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('keeps appearance usable when only the proxy namespace is damaged', async () => {
    const directory = prepareRoot()
    const file = settingsPath(directory)
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        proxy: { mode: 'manual' },
        appearance: { colorMode: 'dark' },
      }),
      'utf8',
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = new ElectronAppSettingsStore(directory)
      const setProxy = vi.fn(async (_config: ProxyConfigLike) => {})
      const session = {
        setProxy,
        resolveProxy: vi.fn(async () => 'DIRECT'),
      } as unknown as Session
      const service = new ElectronProxySettingsService(session, store)

      await service.initialize()
      expect(setProxy).toHaveBeenCalledWith({ mode: 'system' })
      expect(store.getAppearance()).toEqual({ colorMode: 'dark' })
      expect(await service.get()).toEqual({
        mode: 'system',
        resolved: 'DIRECT',
      })
      expect(errorSpy).toHaveBeenCalled()

      await service.set({ mode: 'direct' })
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        schemaVersion: 1,
        proxy: { mode: 'direct' },
        appearance: { colorMode: 'dark' },
        logging: { enabled: true, level: 'info' },
      })
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('applies the valid proxy when only the appearance namespace is damaged', async () => {
    const directory = prepareRoot()
    writeFileSync(
      settingsPath(directory),
      JSON.stringify({
        schemaVersion: 1,
        proxy: { mode: 'manual', address: '127.0.0.1:7890' },
        appearance: { colorMode: 'sepia' },
      }),
      'utf8',
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = new ElectronAppSettingsStore(directory)
      const setProxy = vi.fn(async (_config: ProxyConfigLike) => {})
      const session = {
        setProxy,
        resolveProxy: vi.fn(async () => 'DIRECT'),
      } as unknown as Session
      const service = new ElectronProxySettingsService(session, store)

      await service.initialize()
      expect(setProxy).toHaveBeenCalledWith({
        mode: 'fixed_servers',
        proxyRules: 'http=http://127.0.0.1:7890;https=http://127.0.0.1:7890',
      })
      expect(store.getAppearance()).toEqual({ colorMode: 'system' })
      expect(await service.get()).toMatchObject({
        mode: 'manual',
        address: 'http://127.0.0.1:7890',
        resolved: 'DIRECT',
      })
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('serializes concurrent sets and coordinates snapshots with them', async () => {
    const directory = prepareRoot()
    const store = new ElectronAppSettingsStore(directory)
    await store.load()
    const firstProxyStarted = deferred()
    const finishFirstProxy = deferred()
    const applied: ProxyConfigLike[] = []
    let blockFirstProxy = true
    const setProxy = vi.fn(async (config: ProxyConfigLike) => {
      applied.push(config)
      if (blockFirstProxy) {
        blockFirstProxy = false
        firstProxyStarted.resolve()
        await finishFirstProxy.promise
      }
    })
    const resolveProxy = vi.fn(async () => 'DIRECT')
    const session = { setProxy, resolveProxy } as unknown as Session
    const service = new ElectronProxySettingsService(session, store)

    const firstSet = service.set({
      mode: 'manual',
      address: 'http://127.0.0.1:7890',
    })
    await firstProxyStarted.promise
    const secondSet = service.set({
      mode: 'manual',
      address: 'https://127.0.0.1:8443',
    })
    const pendingGet = service.get()

    expect(setProxy).toHaveBeenCalledTimes(1)
    expect(resolveProxy).not.toHaveBeenCalled()
    finishFirstProxy.resolve()

    const [firstResult, secondResult, getResult] = await Promise.all([
      firstSet,
      secondSet,
      pendingGet,
    ])
    expect(firstResult).toMatchObject({
      mode: 'manual',
      address: 'http://127.0.0.1:7890',
    })
    expect(secondResult).toMatchObject({
      mode: 'manual',
      address: 'https://127.0.0.1:8443',
    })
    expect(getResult).toEqual(secondResult)
    expect(store.getProxy()).toEqual({
      mode: 'manual',
      address: 'https://127.0.0.1:8443',
    })
    expect(readPersistedProxy(directory)).toEqual(store.getProxy())
    expect(applied.at(-1)).toEqual(toProxyConfig(store.getProxy()))
  })

  it('restores the previous session proxy when the file write fails', async () => {
    const directory = prepareRoot()
    const store = new ElectronAppSettingsStore(directory)
    await store.load()
    await store.setProxy({ mode: 'direct' })
    const file = settingsPath(directory)
    chmodSync(file, 0o444)
    const setProxy = vi.fn(async (_config: ProxyConfigLike) => {})
    const session = {
      setProxy,
      resolveProxy: vi.fn(async () => 'DIRECT'),
    } as unknown as Session
    const service = new ElectronProxySettingsService(session, store)

    try {
      await expect(
        service.set({ mode: 'manual', address: '127.0.0.1:7890' }),
      ).rejects.toMatchObject({ code: 'E_SETTINGS_WRITE' })
    } finally {
      chmodSync(file, 0o666)
    }
    expect(setProxy).toHaveBeenCalledTimes(2)
    expect(setProxy).toHaveBeenLastCalledWith({ mode: 'direct' })
    expect(store.getProxy()).toEqual({ mode: 'direct' })
  })

  it('reports a rollback failure with its cause', async () => {
    const directory = prepareRoot()
    const store = new ElectronAppSettingsStore(directory)
    await store.load()
    vi.spyOn(store, 'setProxy').mockRejectedValueOnce(new Error('disk full'))
    const rollbackError = new Error('session unavailable')
    const setProxy = vi
      .fn(async (_config: ProxyConfigLike) => {})
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(rollbackError)
    const session = {
      setProxy,
      resolveProxy: vi.fn(async () => 'DIRECT'),
    } as unknown as Session
    const service = new ElectronProxySettingsService(session, store)

    await expect(
      service.set({ mode: 'manual', address: '127.0.0.1:7890' }),
    ).rejects.toMatchObject({
      name: 'ProxySettingsError',
      code: 'E_SETTINGS_UNAVAILABLE',
      message: expect.stringContaining('rolling back'),
      cause: rollbackError,
    })
    expect(store.getProxy()).toEqual({ mode: 'system' })
  })

  it('returns the resolved diagnostic without persisting it', async () => {
    const directory = prepareRoot()
    const store = new ElectronAppSettingsStore(directory)
    await store.load()
    const setProxy = vi.fn(async (_config: ProxyConfigLike) => {})
    const session = {
      setProxy,
      resolveProxy: vi.fn(async () => 'PROXY 127.0.0.1:7890'),
    } as unknown as Session
    const service = new ElectronProxySettingsService(session, store)

    const result = await service.set({
      mode: 'manual',
      address: '127.0.0.1:7890',
    })
    expect(result).toMatchObject({
      mode: 'manual',
      address: 'http://127.0.0.1:7890',
      resolved: 'PROXY 127.0.0.1:7890',
    })
    expect(readPersistedProxy(directory)).toEqual({
      mode: 'manual',
      address: 'http://127.0.0.1:7890',
    })
  })
})
