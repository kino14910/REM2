/**
 * Integration test: theme chain (extension slot -> host -> renderer data source).
 *
 * Rationale (a link that really broke):
 * `theme-dark` contributes its themes into the `ui.theme` extension slot, but the
 * host's `ui.theme.list` responder read a separate memory (ThemeRegistryImpl).
 * Nothing connected the two sides - theme data stopped at the extension point:
 * `ui.theme.list` always returned [] and `ui.theme.set` always failed, so the
 * frontend could never obtain themes. This was the fourth case of "producer
 * registered, consumer never wired up".
 *
 * The slot is a multi slot (theme catalog): light and dark must be resident at the
 * same time for a mode switch to exist at all, and "which one is applied" is host
 * state, not a contribution.
 *
 * This suite drives the kernel + extension points directly and asserts the slot
 * really holds readable contributions. The host-side pull-sync logic lives in
 * `host/ipc/method-handlers.ts` (`syncThemeFromExtension()`); since the table was
 * extracted from `main.ts` it no longer imports electron, so this suite can drive
 * the real implementation instead of re-implementing the same verification
 * semantics (a replica would drift from the implementation).
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Kernel } from '../../src/kernel/kernel.js'
import { createDeps } from '../../src/kernel/composition.js'
import { KernelTokens } from '../../src/kernel/contracts/kernel-tokens.js'
import { Topics } from '../../src/kernel/topics.js'
import type { EventBus } from '../../src/kernel/contracts/event-bus.js'
import type { ThemeDefinition } from '../../src/kernel/contracts/ui.js'
import { ThemeRegistryImpl } from '../../src/host/electron/theme-registry.js'
import { createMethodHandlers } from '../../src/host/ipc/method-handlers.js'
import { channels } from '../../src/shared/ipc-contract.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(HERE, '..', '..')
const BUILTIN_ROOT = path.join(PROJECT_ROOT, 'plugins-dist')

function createKernel(): Kernel {
  return new Kernel(
    createDeps({
      id: 'rem2-theme-chain',
      roots: [],
      builtinRoot: BUILTIN_ROOT,
      startTimeoutMs: 8000,
      stopTimeoutMs: 8000,
      legacyFallback: false,
      logLevel: 'error',
    }),
  )
}

describe('integration · theme chain', () => {
  it('theme-dark contributes both modes into the ui.theme slot', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()

      const contributed = kernel.extensions.listAll<ThemeDefinition>('ui.theme')
      expect(contributed.map(t => t.id).toSorted()).toEqual(['dark', 'light'])
      // `mode` is what the shell pairs into the switch; without it the renderer would
      // have to infer the mode from the id string (the cross-layer string trap).
      for (const theme of contributed) {
        expect(theme.mode).toBe(theme.id)
      }
      const dark = contributed.find(t => t.mode === 'dark')
      expect(dark?.colors.background).toBe('#0f1115')
    } finally {
      await kernel.shutdown()
    }
  })

  it('after host pull-sync, the registry holds the catalog and activates dark by default', async () => {
    const kernel = createKernel()
    try {
      await kernel.start()
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
      const registry = new ThemeRegistryImpl()

      // Real implementation: the extension slot is the single source of truth and
      // the registry degrades to a cache; on plugin unload the kernel force-reclaims
      // by pluginId (P6), so the next pull naturally syncs to empty.
      const handlers = createMethodHandlers({
        kernel,
        bus,
        themeRegistry: registry,
      })
      bus.respond(channels.themeList, handlers[channels.themeList]!)
      bus.respond(channels.themeSet, handlers[channels.themeSet]!)

      // Pre-fix semantics: without a pull it is empty (this assertion records the defect itself)
      expect(registry.list()).toEqual([])

      const catalog = await bus.request<
        undefined,
        { themes: ThemeDefinition[]; activeId?: string }
      >(channels.themeList, undefined, { timeoutMs: 5000 })
      expect(catalog.themes.map(t => t.id).toSorted()).toEqual([
        'dark',
        'light',
      ])
      // Dark default: the shell's CSS fallbacks are dark, so first paint does not flash.
      expect(catalog.activeId).toBe('dark')

      const set = await bus.request<{ themeId: string }, { ok: boolean }>(
        channels.themeSet,
        { themeId: 'light' },
        { timeoutMs: 5000 },
      )
      expect(set.ok).toBe(true)
      expect(registry.active()).toBe('light')

      const after = await bus.request<
        undefined,
        { themes: ThemeDefinition[]; activeId?: string }
      >(channels.themeList, undefined, { timeoutMs: 5000 })
      expect(after.activeId).toBe('light')
    } finally {
      await kernel.shutdown()
    }
  })

  it('switching to the already-active theme emits nothing (no set -> emit -> set loop)', async () => {
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
      const themeSet = handlers[channels.themeSet]!

      const emitted: unknown[] = []
      bus.on(Topics.UiThemeChanged, payload => {
        emitted.push(payload)
      })

      expect(await themeSet({ themeId: 'light' })).toEqual({ ok: true })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(emitted.length).toBe(1)

      // A second identical switch is a no-op: emitting again would make the renderer
      // push the same theme back, forever.
      expect(await themeSet({ themeId: 'light' })).toEqual({ ok: true })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(emitted.length).toBe(1)
    } finally {
      await kernel.shutdown()
    }
  })

  it('after unloading theme-dark the catalog expires automatically (pull model, no unload listener needed)', async () => {
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
      bus.respond(channels.themeList, handlers[channels.themeList]!)

      const before = await bus.request<
        undefined,
        { themes: ThemeDefinition[]; activeId?: string }
      >(channels.themeList, undefined, { timeoutMs: 5000 })
      expect(before.themes.length).toBe(2)

      await kernel.unloadPlugin('com.rem2.theme-dark')

      const after = await bus.request<
        undefined,
        { themes: ThemeDefinition[]; activeId?: string }
      >(channels.themeList, undefined, { timeoutMs: 5000 })
      expect(after.themes).toEqual([])
      expect(after.activeId).toBeUndefined()
      expect(registry.active()).toBeUndefined()
    } finally {
      await kernel.shutdown()
    }
  })
})
