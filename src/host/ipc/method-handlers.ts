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

import type {
  LocalPluginManager,
  RemoteProgress,
} from '@/host/plugins/local-plugin-manager.js'
import type { AppearanceSettingsService } from '@/host/settings/appearance-settings.js'
import type { ProxySettingsService } from '@/host/settings/proxy-settings-service.js'
import type { EventBus } from '@/kernel/contracts/event-bus.js'
import type { HealthReport } from '@/kernel/contracts/health.js'
import type {
  PanelContribution,
  RouteContribution,
  ThemeDefinition,
  ThemeRegistry,
} from '@/kernel/contracts/ui.js'
import type { Kernel } from '@/kernel/kernel.js'
import type { AllowedMethod } from '@/shared/ipc-contract.js'

import { PluginManagementError } from '@/host/plugins/errors.js'
import { ProxySettingsError } from '@/host/settings/proxy-settings.js'
import { Topics } from '@/kernel/topics.js'
import { channels } from '@/shared/ipc-contract.js'

import {
  appearanceSettingsArgsOf,
  inspectRemoteArgsOf,
  installRemoteArgsOf,
  noArgsOf,
  operationIdOf,
  panelIdOf,
  permissionGrantArgsOf,
  pluginEnableArgsOf,
  pluginIdOf,
  proxySettingsArgsOf,
  themeIdOf,
  titleBarColorsOf,
  uiEventArgsOf,
  updateCheckArgsOf,
  updateInstallArgsOf,
} from './validate.js'

/** Handler for a single method (args come from the renderer and are untrusted at runtime). */
export type MethodHandler = (args: unknown) => unknown | Promise<unknown>

export type MethodFactory = (ctx: MethodContext) => MethodHandler | null

export interface PluginActionConfirmation {
  action:
    | 'enable'
    | 'permission-grant'
    | 'directory-install'
    | 'remote-install'
    | 'update-install'
    | 'proxy-change'
  title: string
  message: string
  detail: string
}

export interface MethodContext {
  kernel: Kernel
  bus: EventBus
  themeRegistry: ThemeRegistry
  /** Electron nativeTheme in production; deterministic injection for tests. */
  isSystemDark?: () => boolean
  /**
   * Applies renderer-measured title bar colors to the native window-controls
   * overlay (Windows/Linux). The overlay is OS-painted, so this cannot be driven
   * from theme data alone: the renderer reports what the bar actually renders.
   */
  applyTitleBarOverlay?: (colors: {
    color: string
    symbolColor: string
  }) => void
  pluginManager?: LocalPluginManager
  /** Host proxy settings (Electron session in production, fake in tests). */
  proxySettings?: ProxySettingsService
  /** Host appearance settings (JSON store in production, fake in tests). */
  appearanceSettings?: AppearanceSettingsService
  choosePluginDirectory?: () => Promise<string | undefined>
  /**
   * Main-process consent boundary for sensitive plugin actions. The browser UI
   * has its own dialogs, but a compromised renderer can call IPC directly, so
   * production must supply a native confirmation here.
   */
  confirmPluginAction?: (request: PluginActionConfirmation) => Promise<boolean>
}

async function confirmPluginAction(
  ctx: MethodContext,
  request: PluginActionConfirmation,
): Promise<void> {
  if (!ctx.confirmPluginAction) {
    // Fail closed: a host that cannot present consent must not execute a
    // sensitive action just because the renderer asked for it.
    throw new PluginManagementError(
      'E_CONFIRMATION_UNAVAILABLE',
      'the host cannot display a confirmation dialog for this action',
    )
  }
  const approved = await ctx.confirmPluginAction(request)
  if (!approved) {
    throw new PluginManagementError(
      'E_CONFIRMATION_DENIED',
      'the plugin action was not confirmed',
    )
  }
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

function proxySettingsOf(ctx: MethodContext): ProxySettingsService {
  if (!ctx.proxySettings) {
    throw new ProxySettingsError(
      'E_SETTINGS_UNAVAILABLE',
      'proxy settings service is unavailable',
    )
  }
  return ctx.proxySettings
}

function appearanceSettingsOf(ctx: MethodContext): AppearanceSettingsService {
  if (!ctx.appearanceSettings) {
    throw new Error('appearance settings service is unavailable')
  }
  return ctx.appearanceSettings
}

/**
 * Project manager progress into the kernel event bus.
 *
 * The operation id comes from the renderer so progress can be correlated
 * before the call returns; without one there is nothing to correlate.
 */
function progressSinkFor(
  ctx: MethodContext,
  operationId: string | undefined,
): ((progress: RemoteProgress) => void) | undefined {
  if (!operationId) return undefined
  return progress => {
    void ctx.bus.emit(Topics.PluginDownloadProgress, {
      operationId,
      phase: progress.phase,
      ...(progress.receivedBytes !== undefined
        ? { receivedBytes: progress.receivedBytes }
        : {}),
      ...(progress.totalBytes !== undefined
        ? { totalBytes: progress.totalBytes }
        : {}),
    })
  }
}

/**
 * Sync contributions from the `ui.theme` extension slot into the theme registry.
 *
 * Why this bridge is needed (it really broke once): `theme-switcher` contributes its
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
function materializeThemes(
  contributed: readonly ThemeDefinition[],
  ctx: MethodContext,
): ThemeDefinition[] {
  const systemMode = ctx.isSystemDark?.() === true ? 'dark' : 'light'
  return contributed.map(theme => {
    if (!theme.followSystem) return theme
    const effective = contributed.find(
      candidate =>
        !candidate.followSystem &&
        (candidate.id === systemMode || candidate.mode === systemMode),
    )
    if (!effective) return { ...theme, mode: systemMode }
    return {
      ...theme,
      mode: systemMode,
      colors: {
        ...effective.colors,
        ...(theme.colors.accent !== undefined
          ? { accent: theme.colors.accent }
          : {}),
      },
      fonts: { ...effective.fonts },
      spacing: { ...effective.spacing },
    }
  })
}

function syncThemeFromExtension(ctx: MethodContext): void {
  const contributed = materializeThemes(
    ctx.kernel.extensions.listAll<ThemeDefinition>('ui.theme'),
    ctx,
  )
  const existing = new Set(contributed.map(t => t.id))

  for (const t of ctx.themeRegistry.list()) {
    if (!existing.has(t.id)) ctx.themeRegistry.unregister(t.id)
  }
  // Register every entry, not only new ids: plugins may replace or mutate tokens
  // and the OS may have changed the effective palette of a followSystem entry.
  for (const t of contributed) ctx.themeRegistry.register(t)

  if (ctx.themeRegistry.active()) return
  const preferred = contributed.find(t => t.mode === 'dark') ?? contributed[0]
  if (preferred) ctx.themeRegistry.activate(preferred.id)
}

/** Plugin-side refresh after in-place token changes (not exposed as a renderer IPC method). */
export function createThemeRefreshHandler(ctx: MethodContext): MethodHandler {
  return () => {
    syncThemeFromExtension(ctx)
    const activeId = ctx.themeRegistry.active()
    const active = activeId ? ctx.themeRegistry.get(activeId) : undefined
    if (active) void ctx.bus.emit(Topics.UiThemeChanged, active)
    return active ?? null
  }
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
    return async args => {
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
      // Mirror the selection into the JSON appearance settings, so the color
      // mode survives even if the catalog later disappears (plugin removed).
      if (ok && ctx.appearanceSettings) {
        const activated = ctx.themeRegistry.get(id)
        const colorMode =
          activated?.followSystem === true || activated?.mode === 'system'
            ? 'system'
            : activated?.mode
        if (colorMode) {
          try {
            await ctx.appearanceSettings.set({ colorMode })
          } catch (error) {
            console.error(
              '[rem2-kernel] Failed to persist the color mode:',
              error,
            )
          }
        }
      }
      return { ok }
    }
  },

  /**
   * Title bar colors measured by the renderer. Fire-and-forget styling: a host
   * without a native overlay (macOS, tests) just accepts the values.
   */
  [channels.titleBarColors]: ({ applyTitleBarOverlay }): MethodHandler => {
    return args => {
      const colors = titleBarColorsOf(args)
      applyTitleBarOverlay?.(colors)
      return { ok: true }
    }
  },

  [channels.uiEvent]: ({ kernel, bus }): MethodHandler => {
    return async args => {
      const { panelId, kind, payload } = uiEventArgsOf(args)
      const panels = kernel.extensions.listAll<PanelContribution>('ui.panel')
      const panel = panels.find(p => p.panelId === panelId)
      if (!panel) return { ok: false }
      const result = await bus.request(panel.command, { kind, payload })
      // Preserve a plugin's explicit rejection (including its error message).
      if (typeof result === 'object' && result !== null && 'ok' in result) {
        return result
      }
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
      const manager = pluginManagerOf(ctx)
      // Read the manifest before installing so the capability approval happens
      // before any file is copied and before the plugin starts.
      const inspected = await manager.inspectDirectory(source)
      await confirmPluginAction(ctx, {
        action: 'directory-install',
        title: 'Install and enable plugin',
        message: `Install "${inspected.name}" and enable it?`,
        detail: [
          `${inspected.id} ${inspected.version}`,
          inspected.requires.length > 0
            ? `Capabilities to approve: ${inspected.requires.join(', ')}`
            : 'Capabilities: none declared',
          'Installing enables the plugin immediately and starts executable plugin code.',
        ].join('\n'),
      })
      return await manager.installFromDirectory(source, {
        capabilities: inspected.requires,
      })
    }
  },

  [channels.pluginEnable]: (ctx): MethodHandler => {
    return async args => {
      const manager = pluginManagerOf(ctx)
      const { pluginId, capabilities } = pluginEnableArgsOf(args)
      const plugin = await manager.detail(pluginId)
      const willEnable = !plugin.enabled
      if (willEnable || capabilities) {
        await confirmPluginAction(ctx, {
          action: 'enable',
          title: capabilities ? 'Grant and enable plugin' : 'Enable plugin',
          message: capabilities
            ? `Grant capabilities and enable "${plugin.name}"?`
            : `Enable "${plugin.name}"?`,
          detail: [
            `${plugin.id} ${plugin.version}`,
            `Source: ${plugin.source}`,
            capabilities
              ? `Capabilities to grant: ${capabilities.join(', ')}`
              : plugin.requires.length > 0
                ? `Capabilities: ${plugin.requires.join(', ')}`
                : 'Capabilities: none declared',
            'Enabling starts executable plugin code.',
          ].join('\n'),
        })
      }
      if (capabilities) {
        await manager.grantPermissions(pluginId, capabilities, {
          version: plugin.version,
          ...(plugin.origin?.sha256 ? { sha256: plugin.origin.sha256 } : {}),
        })
      }
      return await manager.enable(pluginId, {
        version: plugin.version,
        ...(plugin.origin?.sha256 ? { sha256: plugin.origin.sha256 } : {}),
      })
    }
  },

  [channels.pluginPermissionGrant]: (ctx): MethodHandler => {
    return async args => {
      const manager = pluginManagerOf(ctx)
      const { pluginId, capabilities } = permissionGrantArgsOf(args)
      const plugin = await manager.detail(pluginId)
      await confirmPluginAction(ctx, {
        action: 'permission-grant',
        title: 'Grant plugin capabilities',
        message: `Grant capabilities to "${plugin.name}"?`,
        detail: [
          plugin.id,
          `Capabilities: ${capabilities.join(', ')}`,
          'A grant only expands what the plugin may access; it does not sandbox anything else.',
        ].join('\n'),
      })
      return await manager.grantPermissions(pluginId, capabilities, {
        version: plugin.version,
        ...(plugin.origin?.sha256 ? { sha256: plugin.origin.sha256 } : {}),
      })
    }
  },

  [channels.pluginDisable]: (ctx): MethodHandler => {
    return args => pluginManagerOf(ctx).disable(pluginIdOf(args))
  },

  [channels.pluginUninstall]: (ctx): MethodHandler => {
    // Uninstall has no confirmation banner or dialog; the UI button is the
    // consent, and a renderer cannot be tricked into an extra prompt.
    return args => pluginManagerOf(ctx).uninstall(pluginIdOf(args))
  },

  [channels.pluginRestart]: (ctx): MethodHandler => {
    return args => {
      noArgsOf(args)
      return pluginManagerOf(ctx).restart()
    }
  },

  [channels.pluginRemoteInspect]: (ctx): MethodHandler => {
    return async args => {
      const { url, operationId } = inspectRemoteArgsOf(args)
      const sink = progressSinkFor(ctx, operationId)
      return await pluginManagerOf(ctx).inspectRemote({
        url,
        ...(operationId ? { operationId } : {}),
        ...(sink ? { onProgress: sink } : {}),
      })
    }
  },

  [channels.pluginInstallFromRemote]: (ctx): MethodHandler => {
    return async args => {
      const { operationId, url, sha256, capabilities } =
        installRemoteArgsOf(args)
      await confirmPluginAction(ctx, {
        action: 'remote-install',
        title: 'Install remote plugin',
        message: 'Install this remote plugin package and enable it?',
        detail: [
          `Source: ${url}`,
          sha256
            ? `SHA-256: ${sha256}`
            : 'SHA-256: missing (install will be blocked)',
          capabilities && capabilities.length > 0
            ? `Capabilities to approve: ${capabilities.join(', ')}`
            : 'Capabilities: none declared',
          'Installing enables the plugin immediately and starts executable plugin code.',
        ].join('\n'),
      })
      return await pluginManagerOf(ctx).installFromRemote(
        {
          operationId,
          url,
          ...(sha256 ? { sha256 } : {}),
          ...(capabilities ? { capabilities } : {}),
        },
        progressSinkFor(ctx, operationId),
      )
    }
  },

  [channels.pluginReinstall]: (ctx): MethodHandler => {
    return async args => {
      const manager = pluginManagerOf(ctx)
      const pluginId = pluginIdOf(args)
      const plugin = await manager.detail(pluginId)
      if (plugin.state !== 'NotInstalled') {
        throw new PluginManagementError(
          'E_DUPLICATE_ID',
          `plugin is already installed: ${pluginId}`,
        )
      }
      if (
        plugin.origin?.kind !== 'remote' ||
        !plugin.origin.url ||
        !plugin.origin.sha256
      ) {
        throw new PluginManagementError(
          'E_SOURCE_INVALID',
          'this plugin was installed from a local directory; choose its folder to install it again',
        )
      }
      await confirmPluginAction(ctx, {
        action: 'remote-install',
        title: 'Install plugin again',
        message: `Install "${plugin.name}" ${plugin.version} again?`,
        detail: [
          `Source: ${plugin.origin.url}`,
          `SHA-256: ${plugin.origin.sha256}`,
          plugin.requires.length > 0
            ? `Capabilities to approve: ${plugin.requires.join(', ')}`
            : 'Capabilities: none declared',
          'Installing enables the plugin immediately and starts executable plugin code.',
        ].join('\n'),
      })
      return await manager.reinstall(pluginId)
    }
  },

  [channels.pluginDownloadCancel]: (ctx): MethodHandler => {
    return args => {
      const operationId = operationIdOf(args)
      return {
        ok: true,
        cancelled: pluginManagerOf(ctx).cancelDownload(operationId),
      }
    }
  },

  [channels.pluginUpdateCheck]: (ctx): MethodHandler => {
    return args => {
      const { pluginId } = updateCheckArgsOf(args)
      return pluginManagerOf(ctx).checkUpdates(pluginId)
    }
  },

  [channels.pluginUpdateInstall]: (ctx): MethodHandler => {
    return async args => {
      const { operationId, pluginId, expectedVersion, expectedSha256 } =
        updateInstallArgsOf(args)
      await confirmPluginAction(ctx, {
        action: 'update-install',
        title: 'Update plugin',
        message: `Update "${pluginId}" to ${expectedVersion}?`,
        detail: [
          `Version: ${expectedVersion}`,
          `SHA-256: ${expectedSha256}`,
          'The current version is backed up and restored if the update fails.',
        ].join('\n'),
      })
      return await pluginManagerOf(ctx).applyUpdate(
        { operationId, pluginId, expectedVersion, expectedSha256 },
        progressSinkFor(ctx, operationId),
      )
    }
  },

  [channels.settingsProxyGet]: (ctx): MethodHandler => {
    return args => {
      noArgsOf(args)
      return proxySettingsOf(ctx).get()
    }
  },

  [channels.settingsProxySet]: (ctx): MethodHandler => {
    return async args => {
      const settings = proxySettingsArgsOf(args)
      await confirmPluginAction(ctx, {
        action: 'proxy-change',
        title: 'Change network proxy',
        message: `Switch network proxy mode to "${settings.mode}"?`,
        detail: [
          ...(settings.address ? [`Address: ${settings.address}`] : []),
          ...(settings.bypass ? [`Bypass: ${settings.bypass}`] : []),
          'All Electron HTTP(S) traffic and plugin downloads use this proxy.',
        ].join('\n'),
      })
      return await proxySettingsOf(ctx).set(settings)
    }
  },

  [channels.settingsAppearanceGet]: (ctx): MethodHandler => {
    return args => {
      noArgsOf(args)
      return appearanceSettingsOf(ctx).get()
    }
  },

  [channels.settingsAppearanceSet]: (ctx): MethodHandler => {
    return async args => {
      const settings = appearanceSettingsArgsOf(args)
      return await appearanceSettingsOf(ctx).set(settings)
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
