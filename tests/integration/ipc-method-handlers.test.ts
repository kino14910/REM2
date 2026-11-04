/**
 * Integration test: host implementation table for allowlisted methods (`host/ipc/method-handlers.ts`).
 *
 * Rationale: the table was extracted from `host/electron/main.ts` (the method
 * names in those `respond('ui.panel.list', ...)` calls were hand-copied). After
 * extraction it no longer imports electron, so this file can drive it directly -
 * no need to re-implement the same verification semantics like `theme-chain.test.ts`.
 *
 * This suite covers three things:
 * 1. The key set must match the allowlist exactly (a missing one is a compile error, asserted again at runtime here).
 * 2. `command.execute` must be `null` (the host must not implement it, or self-recursion triggers).
 * 3. Each handler behaves correctly (data comes from kernel extension points and the health service, not hardcoded values).
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RegistryMarketService } from '@/host/registry/market-service.js'
import type { AppearanceSettingsService } from '@/host/settings/appearance-settings.js'
import type { LoggingSettingsService } from '@/host/settings/logging-settings.js'
import type { ProxySettingsService } from '@/host/settings/proxy-settings-service.js'
import type { EventBus } from '@/kernel/contracts/event-bus.js'
import type { HealthReport } from '@/kernel/contracts/health.js'
import type { ThemeDefinition } from '@/kernel/contracts/ui.js'

import { ThemeRegistryImpl } from '@/host/electron/theme-registry.js'
import { createMethodHandlers } from '@/host/ipc/method-handlers.js'
import { createDeps } from '@/kernel/composition.js'
import { KernelTokens } from '@/kernel/contracts/kernel-tokens.js'
import { Kernel } from '@/kernel/kernel.js'
import { ALLOWED_METHODS, channels } from '@/shared/ipc-contract.js'

import {
  cleanupTestPluginDataRoots,
  createTestPluginDataRoot,
} from '../helpers/plugin-data-root.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(HERE, '..', '..')
const BUILTIN_ROOT = path.join(PROJECT_ROOT, 'plugins-dist')
/** Theme Switcher is external: built into plugins-external-dist, installed as a user plugin. */
const EXTERNAL_ROOT = path.join(PROJECT_ROOT, 'plugins-external-dist')
const THEME_ID = 'com.rem2.theme-switcher'
const THEME_CAPABILITIES = ['ui.theme', 'ui.panel', 'ui.route']

function createKernel(): Kernel {
  return new Kernel(
    createDeps({
      id: 'rem2-ipc-method-handlers',
      roots: [EXTERNAL_ROOT],
      builtinRoot: BUILTIN_ROOT,
      grantedCapabilities: id => (id === THEME_ID ? THEME_CAPABILITIES : []),
      pluginDataRoot: createTestPluginDataRoot('ipc-handlers'),
      startTimeoutMs: 8000,
      stopTimeoutMs: 8000,
      legacyFallback: false,
      logLevel: 'error',
    }),
  )
}

afterEach(cleanupTestPluginDataRoots)

describe('integration · allowlisted method implementation table', () => {
  it('the key set matches the allowlist exactly; command.execute is null (the host does not implement it)', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      const handlers = createMethodHandlers({
        kernel,
        bus,
        themeRegistry: new ThemeRegistryImpl(),
      })

      expect(Object.keys(handlers).toSorted()).toEqual(
        [...ALLOWED_METHODS].toSorted(),
      )
      // Guard against the self-recursion trap: a host command.execute forwarder would stack-overflow.
      expect(handlers[channels.commandExecute]).toBeNull()
      // The remaining 7 must all have implementations.
      for (const method of ALLOWED_METHODS) {
        if (method === channels.commandExecute) continue
        expect(
          handlers[method],
          `${method} lacks a host implementation`,
        ).not.toBeNull()
      }
    } finally {
      await kernel.shutdown()
    }
  })

  it('ui.panel.list / ui.route.list read the extension slots (theme-switcher contributes them)', async () => {
    // The external theme-switcher contributes exactly one panel + one route;
    // these assertions prove the handlers read the extension slots (not a
    // hardcoded list) because the values correspond to its plugin.json.
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      const handlers = createMethodHandlers({
        kernel,
        bus,
        themeRegistry: new ThemeRegistryImpl(),
      })

      const panelList = handlers[channels.panelList]!
      const routeList = handlers[channels.routeList]!
      const panels = (await panelList(undefined)) as Array<
        Record<string, unknown>
      >
      const routes = (await routeList(undefined)) as Array<
        Record<string, unknown>
      >
      expect(panels).toHaveLength(1)
      expect(panels).toEqual([
        expect.objectContaining({
          panelId: 'theme-switcher',
          command: 'com.rem2.theme-switcher.data',
          region: 'main',
          order: 20,
        }),
      ])
      expect(routes).toHaveLength(1)
      expect(routes).toEqual([
        expect.objectContaining({
          path: '/theme',
          panelId: 'theme-switcher',
          order: 20,
        }),
      ])
    } finally {
      await kernel.shutdown()
    }
  })

  it('ui.theme.list / ui.theme.set go through pull-sync from the extension slot', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      const registry = new ThemeRegistryImpl()
      const handlers = createMethodHandlers({
        kernel,
        bus,
        themeRegistry: registry,
      })

      const themeList = handlers[channels.themeList]!
      const themeSet = handlers[channels.themeSet]!

      const catalog = (await themeList(undefined)) as {
        themes: ThemeDefinition[]
        activeId?: string
      }
      expect(catalog.themes.map(t => t.id).toSorted()).toEqual([
        'dark',
        'light',
        'system',
      ])
      expect(catalog.activeId).toBe('dark')
      expect(registry.active()).toBe('dark')

      expect(await themeSet({ themeId: 'light' })).toEqual({ ok: true })
      expect(registry.active()).toBe('light')
      expect(await themeSet({ themeId: 'not-a-theme' })).toEqual({ ok: false })
    } finally {
      await kernel.shutdown()
    }
  })

  it('ui.theme.set mirrors the selected mode into the appearance settings', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      const written: string[] = []
      const appearanceSettings: AppearanceSettingsService = {
        get: () => ({ colorMode: 'system' }),
        set: async settings => {
          written.push(settings.colorMode)
          return settings
        },
      }
      const handlers = createMethodHandlers({
        kernel,
        bus,
        themeRegistry: new ThemeRegistryImpl(),
        appearanceSettings,
      })
      const themeSet = handlers[channels.themeSet]!

      expect(await themeSet({ themeId: 'light' })).toEqual({ ok: true })
      expect(await themeSet({ themeId: 'system' })).toEqual({ ok: true })
      // An unregistered id changes nothing and persists nothing.
      expect(await themeSet({ themeId: 'not-a-theme' })).toEqual({ ok: false })
      expect(written).toEqual(['light', 'system'])
    } finally {
      await kernel.shutdown()
    }
  })

  it('settings.appearance.get / set delegate to the host store and validate args', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      const appearanceSettings: AppearanceSettingsService = {
        get: () => ({ colorMode: 'dark' }),
        set: async settings => ({ ...settings }),
      }
      const handlers = createMethodHandlers({
        kernel,
        bus,
        themeRegistry: new ThemeRegistryImpl(),
        appearanceSettings,
      })

      expect(
        await handlers[channels.settingsAppearanceGet]!(undefined),
      ).toEqual({
        colorMode: 'dark',
      })
      expect(
        await handlers[channels.settingsAppearanceSet]!({ colorMode: 'light' }),
      ).toEqual({
        colorMode: 'light',
      })
      await expect(async () =>
        handlers[channels.settingsAppearanceSet]!({ colorMode: 'sepia' }),
      ).rejects.toThrow(/colorMode/)
      await expect(async () =>
        handlers[channels.settingsAppearanceGet]!({ colorMode: 'light' }),
      ).rejects.toThrow(/no arguments/)
    } finally {
      await kernel.shutdown()
    }
  })

  it('settings.logging.get / set delegate to the host logging service and validate args', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      const seen: unknown[] = []
      const loggingSettings: LoggingSettingsService = {
        get: () => ({ enabled: false, level: 'debug' }),
        set: async settings => {
          seen.push(settings)
          return { ...settings }
        },
      }
      const handlers = createMethodHandlers({
        kernel,
        bus,
        themeRegistry: new ThemeRegistryImpl(),
        loggingSettings,
      })

      expect(await handlers[channels.settingsLoggingGet]!(undefined)).toEqual({
        enabled: false,
        level: 'debug',
      })
      expect(
        await handlers[channels.settingsLoggingSet]!({
          enabled: true,
          level: 'warn',
        }),
      ).toEqual({ enabled: true, level: 'warn' })
      expect(seen).toEqual([{ enabled: true, level: 'warn' }])
      await expect(async () =>
        handlers[channels.settingsLoggingSet]!({
          enabled: true,
          level: 'verbose',
        }),
      ).rejects.toThrow(/logging level/)
      await expect(async () =>
        handlers[channels.settingsLoggingGet]!({ enabled: true }),
      ).rejects.toThrow(/no arguments/)
    } finally {
      await kernel.shutdown()
    }
  })

  it('ui.event / ui.panel.data return ok:false / throw for unknown panels (not silent)', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      const handlers = createMethodHandlers({
        kernel,
        bus,
        themeRegistry: new ThemeRegistryImpl(),
      })

      const uiEvent = handlers[channels.uiEvent]!
      const panelData = handlers[channels.panelData]!
      expect(await uiEvent({ panelId: 'nope', kind: 'click' })).toEqual({
        ok: false,
      })
      await expect(panelData({ panelId: 'nope' })).rejects.toThrow(
        /panel not found/,
      )
    } finally {
      await kernel.shutdown()
    }
  })

  it('ui.event preserves an explicit plugin rejection and its error message', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      const handlers = createMethodHandlers({
        kernel,
        bus,
        themeRegistry: new ThemeRegistryImpl(),
      })
      const result = await handlers[channels.uiEvent]!({
        panelId: 'theme-switcher',
        kind: 'change',
        payload: { fieldId: 'mode', value: 'sepia' },
      })
      expect(result).toMatchObject({ ok: false })
      expect((result as { error: string }).error).toMatch(/invalid mode/)
    } finally {
      await kernel.shutdown()
    }
  })

  it('health.report is trimmed to a DTO (no leaking of container / permissions / absolute paths)', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      const handlers = createMethodHandlers({
        kernel,
        bus,
        themeRegistry: new ThemeRegistryImpl(),
      })

      const healthReport = handlers[channels.healthReport]!
      const report = (await healthReport(undefined)) as HealthReport
      expect(report.status).toBeTruthy()
      expect(Array.isArray(report.plugins)).toBe(true)
      // The DTO is an explicit projection whitelist: only these four fields.
      const allowed = new Set(['id', 'state', 'status', 'message'])
      for (const plugin of report.plugins) {
        for (const key of Object.keys(plugin)) {
          expect(allowed.has(key), `health DTO leaks field: ${key}`).toBe(true)
        }
      }
    } finally {
      await kernel.shutdown()
    }
  })

  it('settings.proxy.get / set delegate to the host proxy service and validate args', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      const seen: unknown[] = []
      const proxySettings: ProxySettingsService = {
        get: async () => ({
          mode: 'system',
          resolved: 'PROXY 127.0.0.1:7890',
        }),
        set: async settings => {
          seen.push(settings)
          return {
            ...settings,
            resolved: 'PROXY 127.0.0.1:7890',
          }
        },
      }
      const confirmPluginAction = vi.fn(async () => true)
      const handlers = createMethodHandlers({
        kernel,
        bus,
        themeRegistry: new ThemeRegistryImpl(),
        proxySettings,
        confirmPluginAction,
      })

      expect(await handlers[channels.settingsProxyGet]!(undefined)).toEqual({
        mode: 'system',
        resolved: 'PROXY 127.0.0.1:7890',
      })
      expect(
        await handlers[channels.settingsProxySet]!({
          mode: 'manual',
          address: 'http://127.0.0.1:7890',
          bypass: 'localhost',
        }),
      ).toEqual({
        mode: 'manual',
        address: 'http://127.0.0.1:7890',
        bypass: 'localhost',
        resolved: 'PROXY 127.0.0.1:7890',
      })
      expect(seen).toEqual([
        {
          mode: 'manual',
          address: 'http://127.0.0.1:7890',
          bypass: 'localhost',
        },
      ])
      expect(confirmPluginAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'proxy-change',
          detail: expect.stringContaining('http://127.0.0.1:7890'),
        }),
      )
      await expect(async () =>
        handlers[channels.settingsProxySet]!({ mode: 'manual' }),
      ).rejects.toMatchObject({ code: 'E_SETTINGS_INVALID' })
    } finally {
      await kernel.shutdown()
    }
  })

  it('market install re-resolves the registry, confirms with host data and delegates', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      const release = {
        pluginId: 'com.example.market',
        name: 'Market Example',
        version: '1.0.0',
        downloadUrl:
          'https://github.com/kino14910/REM2-plugins/releases/download/example-v1.0.0/example-1.0.0.zip',
        sha256: 'a'.repeat(64),
        sizeBytes: 5554,
        requires: ['ui.panel'],
        repository: 'https://github.com/kino14910/REM2-plugins',
      }
      const resolve = vi.fn(async () => release)
      const install = vi.fn(async () => ({
        ok: true as const,
        changed: true,
        restartRequired: false,
      }))
      const market = {
        list: vi.fn(),
        resolve,
        install,
      } as unknown as RegistryMarketService
      const confirmPluginAction = vi.fn(async () => true)
      const handlers = createMethodHandlers({
        kernel,
        bus,
        themeRegistry: new ThemeRegistryImpl(),
        market,
        confirmPluginAction,
      })

      await handlers[channels.pluginMarketInstall]!({
        operationId: 'market-install-1',
        pluginId: release.pluginId,
        version: release.version,
      })

      expect(resolve).toHaveBeenCalledWith(release.pluginId, release.version)
      expect(confirmPluginAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'market-install',
          detail: expect.stringContaining('ui.panel'),
        }),
      )
      expect(install).toHaveBeenCalledWith(
        release,
        'market-install-1',
        expect.any(Function),
      )
    } finally {
      await kernel.shutdown()
    }
  })
})
