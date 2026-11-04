import { describe, expect, it, vi } from 'vitest'

import type { LocalPluginManager } from '@/host/plugins/local-plugin-manager.js'
import type {
  PluginDetailDto,
  PluginListDto,
  PluginOperationResultDto,
} from '@/shared/ipc-contract.js'

import { RegistryClient } from '@/host/registry/client.js'
import { RegistryClientError } from '@/host/registry/errors.js'
import { RegistryMarketService } from '@/host/registry/market-service.js'

import {
  makeRegistryIndex,
  makeRegistryPlugin,
  makeRegistryVersion,
} from '../helpers/registry-index.js'

const OPERATION_OK: PluginOperationResultDto = {
  ok: true,
  changed: true,
  restartRequired: false,
}

function localPlugin(
  overrides: Partial<PluginDetailDto> = {},
): PluginDetailDto {
  return {
    id: 'com.rem2.alpha',
    name: 'Alpha',
    version: '1.0.0',
    source: 'user',
    state: 'Active',
    enabled: true,
    builtin: false,
    entry: 'index.js',
    tags: [],
    dependencies: {},
    optionalDependencies: {},
    requires: [],
    permissions: { granted: [], denied: [] },
    compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
    canUninstall: true,
    canInstall: false,
    restartRequired: false,
    ...overrides,
  }
}

function managerStub(plugins: PluginDetailDto[]): {
  manager: LocalPluginManager
  list: ReturnType<typeof vi.fn>
  installFromRemote: ReturnType<typeof vi.fn>
  applyUpdate: ReturnType<typeof vi.fn>
} {
  const list = vi.fn(
    async (): Promise<PluginListDto> => ({
      plugins,
      issues: [],
      restartRequired: false,
    }),
  )
  const installFromRemote = vi.fn(
    async (): Promise<PluginOperationResultDto> => OPERATION_OK,
  )
  const applyUpdate = vi.fn(
    async (): Promise<PluginOperationResultDto> => OPERATION_OK,
  )
  return {
    manager: {
      list,
      installFromRemote,
      applyUpdate,
    } as unknown as LocalPluginManager,
    list,
    installFromRemote,
    applyUpdate,
  }
}

function clientFor(fetchImpl: typeof fetch): RegistryClient {
  return new RegistryClient({ fetchImpl })
}

function indexResponse(index: unknown): Response {
  return new Response(JSON.stringify(index), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function serviceFor(
  fetchImpl: typeof fetch,
  manager: LocalPluginManager,
): RegistryMarketService {
  return new RegistryMarketService({
    client: clientFor(fetchImpl),
    manager,
    kernelVersion: '1.0.0',
    contractVersion: '1',
  })
}

describe('unit · registry market service', () => {
  it('projects install/installed/update/incompatible actions from host state', async () => {
    const index = makeRegistryIndex({
      plugins: [
        makeRegistryPlugin({
          id: 'com.rem2.alpha',
          name: 'Alpha',
          versions: [makeRegistryVersion({ directory: 'alpha' })],
        }),
        makeRegistryPlugin({
          id: 'com.rem2.beta',
          name: 'Beta',
          versions: [makeRegistryVersion({ directory: 'beta' })],
        }),
        makeRegistryPlugin({
          id: 'com.rem2.gamma',
          name: 'Gamma',
          versions: [makeRegistryVersion({ directory: 'gamma' })],
        }),
        makeRegistryPlugin({
          id: 'com.rem2.delta',
          name: 'Delta',
          versions: [
            makeRegistryVersion({
              version: '2.0.0',
              directory: 'delta',
              compatibility: {
                minKernel: '^2.0.0',
                contractVersion: '1',
              },
            }),
          ],
        }),
      ],
    })
    const local = [
      localPlugin({ id: 'com.rem2.alpha', name: 'Alpha', version: '1.0.0' }),
      localPlugin({ id: 'com.rem2.beta', name: 'Beta', version: '0.9.0' }),
      localPlugin({ id: 'com.rem2.delta', name: 'Delta', version: '1.0.0' }),
    ]
    const { manager } = managerStub(local)
    const service = serviceFor(
      vi.fn(async () => indexResponse(index)),
      manager,
    )

    const result = await service.list()

    expect(
      result.plugins.map(plugin => [
        plugin.id,
        plugin.action,
        plugin.installedVersion,
        plugin.updateAvailable,
      ]),
    ).toEqual([
      ['com.rem2.alpha', 'installed', '1.0.0', false],
      ['com.rem2.beta', 'update', '0.9.0', true],
      ['com.rem2.gamma', 'install', undefined, false],
      ['com.rem2.delta', 'incompatible', '1.0.0', false],
    ])
    expect(result.plugins[0]).not.toHaveProperty('downloadUrl')
    expect(result.plugins[0]).not.toHaveProperty('sha256')
    expect(result.source).toBe('network')
    expect(result.stale).toBe(false)
  })

  it('reuses the in-memory index unless a refresh is requested', async () => {
    const fetchImpl = vi.fn(async () => indexResponse(makeRegistryIndex()))
    const { manager } = managerStub([])
    const service = serviceFor(fetchImpl as typeof fetch, manager)

    await service.list()
    await service.list()
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    await service.list({ refresh: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('keeps the previous index when a refresh fails at the transport layer', async () => {
    let offline = false
    const fetchImpl = vi.fn(async () => {
      if (offline) throw new TypeError('offline')
      return indexResponse(makeRegistryIndex())
    })
    const { manager } = managerStub([])
    const service = serviceFor(fetchImpl as typeof fetch, manager)

    await service.list()
    offline = true
    const refreshed = await service.list({ refresh: true })

    expect(refreshed.stale).toBe(true)
    expect(refreshed.plugins).toHaveLength(1)
    expect(refreshed.warnings.join('\n')).toContain('registry refresh failed')
  })

  it('re-resolves an exact plugin version for installation', async () => {
    const index = makeRegistryIndex()
    const fetchImpl = vi.fn(async () => indexResponse(index))
    const { manager } = managerStub([])
    const service = serviceFor(fetchImpl as typeof fetch, manager)

    const release = await service.resolve('com.rem2.theme-switcher', '1.0.0')
    expect(release).toMatchObject({
      pluginId: 'com.rem2.theme-switcher',
      version: '1.0.0',
      downloadUrl:
        'https://github.com/kino14910/REM2-plugins/releases/download/theme-switcher-v1.0.0/theme-switcher-1.0.0.zip',
    })
    expect(release.sha256).toHaveLength(64)
  })

  it('rejects a missing plugin, a missing version or an incompatible release', async () => {
    const fetchImpl = vi.fn(async () => indexResponse(makeRegistryIndex()))
    const { manager } = managerStub([])
    const service = serviceFor(fetchImpl as typeof fetch, manager)

    await expect(
      service.resolve('com.rem2.missing', '1.0.0'),
    ).rejects.toMatchObject({ code: 'E_MARKET_ENTRY_MISSING' })
    await expect(
      service.resolve('com.rem2.theme-switcher', '9.9.9'),
    ).rejects.toMatchObject({ code: 'E_MARKET_VERSION_MISSING' })

    const incompatible = makeRegistryIndex({
      plugins: [
        makeRegistryPlugin({
          versions: [
            makeRegistryVersion({
              compatibility: {
                minKernel: '^2.0.0',
                contractVersion: '1',
              },
            }),
          ],
        }),
      ],
    })
    const incompatibleService = serviceFor(
      vi.fn(async () => indexResponse(incompatible)) as typeof fetch,
      managerStub([]).manager,
    )
    await expect(
      incompatibleService.resolve('com.rem2.theme-switcher', '1.0.0'),
    ).rejects.toMatchObject({ code: 'E_INCOMPATIBLE' })
  })

  it('blocks installation when the registry cannot be confirmed online', async () => {
    const { manager } = managerStub([])
    const service = serviceFor(
      vi.fn(async () => {
        throw new TypeError('offline')
      }) as typeof fetch,
      manager,
    )

    try {
      await service.resolve('com.rem2.theme-switcher', '1.0.0')
      throw new Error('expected a registry failure')
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryClientError)
      expect((error as RegistryClientError).code).toBe('E_REGISTRY_NETWORK')
    }
  })

  it('installs disabled without capabilities and updates by verified source URL', async () => {
    const fetchImpl = vi.fn(async () => indexResponse(makeRegistryIndex()))
    const { manager, installFromRemote, applyUpdate } = managerStub([])
    const service = serviceFor(fetchImpl as typeof fetch, manager)
    const release = await service.resolve('com.rem2.theme-switcher', '1.0.0')

    await service.install(release, 'install-1')
    expect(installFromRemote).toHaveBeenCalledWith(
      {
        url: release.downloadUrl,
        sha256: release.sha256,
        operationId: 'install-1',
        enable: false,
      },
      undefined,
    )
    const installArgs = installFromRemote.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined
    expect(installArgs).not.toHaveProperty('capabilities')

    await service.update(release, 'update-1')
    expect(applyUpdate).toHaveBeenCalledWith(
      {
        pluginId: release.pluginId,
        operationId: 'update-1',
        expectedVersion: release.version,
        expectedSha256: release.sha256,
        sourceUrl: release.downloadUrl,
      },
      undefined,
    )
  })
})
