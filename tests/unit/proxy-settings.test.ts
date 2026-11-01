import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Session } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ElectronProxySettingsService } from '../../src/host/electron/proxy-settings-service.js'
import {
  normalizeProxySettings,
  parseProxyAddress,
  type ProxyConfigLike,
  ProxySettingsError,
  toProxyConfig,
} from '../../src/host/settings/proxy-settings.js'
import { ProxySettingsStore } from '../../src/host/settings/proxy-settings-store.js'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('unit · proxy settings', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  async function settingsPath(): Promise<string> {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-proxy-'))
    return path.join(root, 'proxy-settings.json')
  }

  it('defaults to the system proxy when the file is missing', async () => {
    const store = new ProxySettingsStore(await settingsPath())
    await store.load()
    expect(store.get()).toEqual({ mode: 'system' })
  })

  it('persists manual settings and reloads them in a fresh store', async () => {
    const file = await settingsPath()
    const first = new ProxySettingsStore(file)
    await first.load()
    await first.set({
      mode: 'manual',
      address: 'http://127.0.0.1:7890',
      bypass: 'localhost,127.0.0.1',
    })

    expect(first.get()).toEqual({
      mode: 'manual',
      address: 'http://127.0.0.1:7890',
      bypass: 'localhost,127.0.0.1',
    })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      proxy: {
        mode: 'manual',
        address: 'http://127.0.0.1:7890',
        bypass: 'localhost,127.0.0.1',
      },
    })

    const second = new ProxySettingsStore(file)
    await second.load()
    expect(second.get()).toEqual(first.get())
  })

  it('loads persisted manual addresses without a scheme as http', async () => {
    const file = await settingsPath()
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        proxy: { mode: 'manual', address: '127.0.0.1:7890' },
      }),
      'utf8',
    )
    const store = new ProxySettingsStore(file)
    await store.load()
    expect(store.get()).toEqual({
      mode: 'manual',
      address: 'http://127.0.0.1:7890',
    })
  })

  it('drops the manual address when switching to direct', async () => {
    const store = new ProxySettingsStore(await settingsPath())
    await store.load()
    await store.set({ mode: 'manual', address: '127.0.0.1:7890' })
    await store.set({ mode: 'direct', address: '127.0.0.1:7890' })
    expect(store.get()).toEqual({ mode: 'direct' })
  })

  it.each([
    ['bad JSON', '{"version":1'],
    ['bad version', '{"version":2,"proxy":{"mode":"system"}}'],
    ['missing proxy', '{"version":1}'],
    ['invalid mode', '{"version":1,"proxy":{"mode":"auto"}}'],
    ['manual without address', '{"version":1,"proxy":{"mode":"manual"}}'],
    [
      'invalid bypass type',
      '{"version":1,"proxy":{"mode":"manual","address":"127.0.0.1:7890","bypass":1}}',
    ],
  ])('rejects %s', async (_label, text) => {
    const file = await settingsPath()
    await writeFile(file, text, 'utf8')
    const store = new ProxySettingsStore(file)
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

  it('serializes concurrent sets and coordinates snapshots with them', async () => {
    const file = await settingsPath()
    const store = new ProxySettingsStore(file)
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
    expect(store.get()).toEqual({
      mode: 'manual',
      address: 'https://127.0.0.1:8443',
    })
    expect(JSON.parse(await readFile(file, 'utf8')).proxy).toEqual(store.get())
    expect(applied.at(-1)).toEqual(toProxyConfig(store.get()))
  })

  it('restores the previous session proxy when persistence fails', async () => {
    const store = new ProxySettingsStore(await settingsPath())
    const persistenceError = new Error('disk full')
    vi.spyOn(store, 'set').mockRejectedValueOnce(persistenceError)
    const setProxy = vi.fn(async (_config: ProxyConfigLike) => {})
    const session = {
      setProxy,
      resolveProxy: vi.fn(async () => 'DIRECT'),
    } as unknown as Session
    const service = new ElectronProxySettingsService(session, store)

    await expect(
      service.set({ mode: 'manual', address: '127.0.0.1:7890' }),
    ).rejects.toBe(persistenceError)
    expect(setProxy).toHaveBeenCalledTimes(2)
    expect(setProxy).toHaveBeenLastCalledWith({ mode: 'system' })
    expect(store.get()).toEqual({ mode: 'system' })
  })

  it('reports a rollback failure with its cause', async () => {
    const store = new ProxySettingsStore(await settingsPath())
    vi.spyOn(store, 'set').mockRejectedValueOnce(new Error('disk full'))
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
    expect(store.get()).toEqual({ mode: 'system' })
  })
})
