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
import { describe, expect, it } from 'vitest'
import { Kernel } from '../../src/kernel/kernel.js'
import { createDeps } from '../../src/kernel/composition.js'
import { KernelTokens } from '../../src/kernel/contracts/kernel-tokens.js'
import type { EventBus } from '../../src/kernel/contracts/event-bus.js'
import type { ThemeDefinition } from '../../src/kernel/contracts/ui.js'
import type { HealthReport } from '../../src/kernel/contracts/health.js'
import { ThemeRegistryImpl } from '../../src/host/electron/theme-registry.js'
import { createMethodHandlers } from '../../src/host/ipc/method-handlers.js'
import { ALLOWED_METHODS, channels } from '../../src/shared/ipc-contract.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(HERE, '..', '..')
const BUILTIN_ROOT = path.join(PROJECT_ROOT, 'plugins-dist')

function createKernel(): Kernel {
  return new Kernel(
    createDeps({
      id: 'rem2-ipc-method-handlers',
      roots: [],
      builtinRoot: BUILTIN_ROOT,
      startTimeoutMs: 8000,
      stopTimeoutMs: 8000,
      legacyFallback: false,
      logLevel: 'error',
    }),
  )
}

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

  it('ui.panel.list / ui.route.list read the extension slots (inspector contributes them)', async () => {
    // The builtin plugin-inspector is in plugins-dist and contributes exactly
    // one panel + one route; these assertions prove the handlers read the
    // extension slots (not a hardcoded list) because the values correspond to
    // the inspector's plugin.json contributes.
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
      expect(panels).toMatchObject([
        {
          panelId: 'plugin-inspector',
          command: 'com.rem2.plugin-inspector.data',
          region: 'main',
          order: 10,
        },
      ])
      expect(routes).toHaveLength(1)
      expect(routes).toMatchObject([
        { path: '/plugins', panelId: 'plugin-inspector', order: 10 },
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
})
