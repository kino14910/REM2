/**
 * Host implementation table for whitelisted IPC methods.
 *
 * Why it is extracted from `host/electron/main.ts`:
 * 1. The method names in the 8 `respond('ui.panel.list', ...)` calls used to be
 *    hand-copied: adding a method to the whitelist but forgetting it here let
 *    the method through the whitelist with no responder, so the frontend got a
 *    `NoResponderError` and nothing asserted that whitelist and implementation
 *    stayed in sync.
 * 2. This file does not import `electron`, so vitest can import it directly;
 *    `host/electron/main.ts` only registers the table onto the event bus.
 *
 * Shape: `Record<AllowedMethod, MethodFactory | null>` with computed keys.
 * - Keys are the true `channels.*` names, so method names appear exactly once in
 *   the repo (in `shared/ipc-contract.ts`);
 * - `Record` requires an entry for every whitelisted method, so a missing entry
 *   is a missing key = compile error;
 * - `null` means "the host does not implement it; a plugin responds the topic
 *   directly" (see `command.execute`).
 *
 * Timing red line: `command.execute` must stay `null`.
 * A responder like `respond('command.execute', () => request(Topics.CommandExecute))`
 * once existed, and `Topics.CommandExecute` is `'command.execute'` itself, so the
 * request hit the same responder and recursed until RangeError: Maximum call
 * stack size exceeded. Dispatch now lives in exactly one place: the kernel
 * `CommandDispatcher`, registered by the kernel at start() and reading the
 * `command.provide` extension slot directly (it never requests the topic
 * itself, so recursion is structurally impossible). With no command plugin
 * installed the dispatcher returns an explicit `{ok:false, error:'unknown
 * command: ...'}` - never silence, never recursion. A regression guard lives
 * in `tests/integration/command-chain.test.ts`.
 */

import { Topics } from '../../kernel/topics.js'
import { channels } from '../../shared/ipc-contract.js'
import type { AllowedMethod } from '../../shared/ipc-contract.js'
import type { Kernel } from '../../kernel/kernel.js'
import type { EventBus } from '../../kernel/contracts/event-bus.js'
import type { HealthReport } from '../../kernel/contracts/health.js'
import type {
  PanelContribution,
  RouteContribution,
  ThemeDefinition,
  ThemeRegistry,
} from '../../kernel/contracts/ui.js'
import {
  noArgsOf,
  panelIdOf,
  pluginIdOf,
  themeIdOf,
  uiEventArgsOf,
} from './validate.js'
import type { LocalPluginManager } from '../plugins/local-plugin-manager.js'
import { PluginManagementError } from '../plugins/errors.js'

/** Handler for a single method (args come from the renderer and are untrusted at runtime). */
export type MethodHandler = (args: unknown) => unknown | Promise<unknown>

export type MethodFactory = (ctx: MethodContext) => MethodHandler | null

export interface MethodContext {
  kernel: Kernel
  bus: EventBus
  themeRegistry: ThemeRegistry
  pluginManager?: LocalPluginManager
  choosePluginDirectory?: () => Promise<string | undefined>
}

function pluginManagerOf(ctx: MethodContext): LocalPluginManager {
  if (!ctx.pluginManager) {
    throw new PluginManagementError(
      'E_MANAGER_UNAVAILABLE',
      'plugin manager is unavailable',
    )
  }
  return ctx.pluginManager
}

/**
 * Sync contributions from the `ui.theme` extension slot into the theme registry.
 *
 * Why this bridge is needed (it really broke once): `theme-dark` contributes its
 * theme into the `ui.theme` slot, but responders read from `themeRegistry` (a
 * separate piece of memory). Nothing connected the two sides, so theme data died at
 * the extension point - `ui.theme.list` always returned [] and `ui.theme.set` always
 * failed, and the frontend never got a theme. Another case of "producer registered,
 * consumer never wired".
 *
 * Uses pull (sync on every read) instead of subscribing to lifecycle events: the
 * extension slot is the single source of truth and the theme registry degrades to a
 * cache. When a plugin unloads, the kernel force-reclaims its contributions by
 * pluginId, so the next pull naturally syncs to empty - no unload listener needed.
 *
 * Activation policy lives here, not in the slot: the slot says which themes exist,
 * the host decides which one is applied. Default preference is `dark` (the shell's
 * CSS fallbacks are dark, so first paint does not flash); an existing selection is
 * never overridden.
 */
function syncThemeFromExtension(ctx: MethodContext): void {
  const contributed = ctx.kernel.extensions.listAll<ThemeDefinition>('ui.theme')
  const existing = new Set(contributed.map(t => t.id))

  for (const t of ctx.themeRegistry.list()) {
    if (!existing.has(t.id)) ctx.themeRegistry.unregister(t.id)
  }
  for (const t of contributed) {
    if (!ctx.themeRegistry.get(t.id)) ctx.themeRegistry.register(t)
  }

  if (ctx.themeRegistry.active()) return
  const preferred = contributed.find(t => t.mode === 'dark') ?? contributed[0]
  if (preferred) ctx.themeRegistry.activate(preferred.id)
}

/**
 * Whitelisted method -> host implementation factory.
 *
 * `null` = the host does not implement it (a plugin responds the topic directly).
 */
export const METHOD_FACTORIES = {
  [channels.panelList]: ({ kernel }): MethodHandler => {
    return () => kernel.extensions.listAll<PanelContribution>('ui.panel')
  },

  // ui.panel.data: routes via the event bus using the panel's declared command; the data shape is plugin-defined
  [channels.panelData]: ({ kernel, bus }): MethodHandler => {
    return async args => {
      const panelId = panelIdOf(args)
      const panels = kernel.extensions.listAll<PanelContribution>('ui.panel')
      const panel = panels.find(p => p.panelId === panelId)
      if (!panel) throw new Error(`panel not found: ${panelId}`)
      return await bus.request(panel.command, { panelId: panel.panelId })
    }
  },

  [channels.routeList]: ({ kernel }): MethodHandler => {
    return () => kernel.extensions.listAll<RouteContribution>('ui.route')
  },

  [channels.themeList]: (ctx): MethodHandler => {
    return () => {
      syncThemeFromExtension(ctx)
      // Catalog + selection: the renderer needs both. With only the list it had to
      // guess which theme the host applied, and the applied theme did not survive a
      // reload (nothing told the renderer about it).
      return {
        themes: ctx.themeRegistry.list(),
        activeId: ctx.themeRegistry.active(),
      }
    }
  },

  [channels.themeSet]: (ctx): MethodHandler => {
    return args => {
      const id = themeIdOf(args)
      syncThemeFromExtension(ctx)
      // Emit only on a real change: emitting on a no-op switch made the renderer
      // re-apply and re-set the same theme, i.e. an endless set -> emit -> set loop.
      const changed = ctx.themeRegistry.active() !== id
      const ok = ctx.themeRegistry.activate(id)
      if (ok && changed) {
        void ctx.bus.emit(
          Topics.UiThemeChanged,
          ctx.themeRegistry.get(id) ?? null,
        )
      }
      return { ok }
    }
  },

  [channels.uiEvent]: ({ kernel, bus }): MethodHandler => {
    return async args => {
      const { panelId, kind, payload } = uiEventArgsOf(args)
      const panels = kernel.extensions.listAll<PanelContribution>('ui.panel')
      const panel = panels.find(p => p.panelId === panelId)
      if (!panel) return { ok: false }
      await bus.request(panel.command, { kind, payload })
      return { ok: true }
    }
  },

  [channels.pluginList]: (ctx): MethodHandler => {
    return args => {
      noArgsOf(args)
      return pluginManagerOf(ctx).list()
    }
  },

  [channels.pluginDetail]: (ctx): MethodHandler => {
    return args => pluginManagerOf(ctx).detail(pluginIdOf(args))
  },

  [channels.pluginInstallFromDirectory]: (ctx): MethodHandler => {
    return async args => {
      noArgsOf(args)
      if (!ctx.choosePluginDirectory) {
        throw new PluginManagementError(
          'E_MANAGER_UNAVAILABLE',
          'plugin directory chooser is unavailable',
        )
      }
      const source = await ctx.choosePluginDirectory()
      if (!source) {
        return {
          ok: true,
          changed: false,
          restartRequired: false,
          message: 'Installation cancelled.',
        }
      }
      return await pluginManagerOf(ctx).installFromDirectory(source)
    }
  },

  [channels.pluginEnable]: (ctx): MethodHandler => {
    return args => pluginManagerOf(ctx).enable(pluginIdOf(args))
  },

  [channels.pluginDisable]: (ctx): MethodHandler => {
    return args => pluginManagerOf(ctx).disable(pluginIdOf(args))
  },

  [channels.pluginUninstall]: (ctx): MethodHandler => {
    return args => pluginManagerOf(ctx).uninstall(pluginIdOf(args))
  },

  [channels.pluginRestart]: (ctx): MethodHandler => {
    return args => {
      noArgsOf(args)
      return pluginManagerOf(ctx).restart()
    }
  },

  // command.execute: the host does not implement it (`null`). A command plugin
  // responds the topic directly; with no command plugin, request throws
  // NoResponderError. Never add a forwarder here - see the timing red line in
  // the file header.
  [channels.commandExecute]: null,

  [channels.healthReport]: ({ kernel }): MethodHandler => {
    return async () => {
      const report: HealthReport = await kernel.health()
      return {
        status: report.status,
        plugins: report.plugins.map(p => ({
          id: p.id,
          state: p.state,
          status: p.status,
          ...(p.message ? { message: p.message } : {}),
        })),
      }
    }
  },
} satisfies Record<AllowedMethod, MethodFactory | null>

/** Whitelisted method -> actual handler (`null` means the host does not implement it). */
export type MethodHandlers = Record<AllowedMethod, MethodHandler | null>

export function createMethodHandlers(ctx: MethodContext): MethodHandlers {
  const out = {} as MethodHandlers
  for (const [method, factory] of Object.entries(METHOD_FACTORIES)) {
    out[method as AllowedMethod] = factory ? factory(ctx) : null
  }
  return out
}
