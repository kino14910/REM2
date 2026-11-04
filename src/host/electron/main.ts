import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  session,
} from 'electron'
import path from 'node:path'
import process from 'node:process'

import type { AppearanceSettingsService } from '@/host/settings/appearance-settings.js'
import type {
  LoggingSettingsService,
  LogServiceLike,
} from '@/host/settings/logging-settings.js'
import type { ProxySettingsService } from '@/host/settings/proxy-settings-service.js'
import type { EventBus } from '@/kernel/contracts/event-bus.js'

import { builtinPluginsRoot } from '@/host/cli/paths.js'
import { ConsoleLogSink } from '@/host/console-log-sink.js'
import { IpcBridge } from '@/host/ipc/bridge.js'
import { EVENT_FORWARD_MAP } from '@/host/ipc/forward-map.js'
import {
  createMethodHandlers,
  createThemeRefreshHandler,
} from '@/host/ipc/method-handlers.js'
import { PluginGrantStore } from '@/host/plugins/grant-store.js'
import { LocalPluginManager } from '@/host/plugins/local-plugin-manager.js'
import { PluginProvenanceStore } from '@/host/plugins/provenance-store.js'
import { PluginRemovedStore } from '@/host/plugins/removed-plugin-store.js'
import { PluginStateStore } from '@/host/plugins/state-store.js'
import { RegistryCache } from '@/host/registry/cache.js'
import { RegistryClient } from '@/host/registry/client.js'
import { RegistryMarketService } from '@/host/registry/market-service.js'
import { createDeps } from '@/kernel/composition.js'
import { KernelTokens } from '@/kernel/contracts/kernel-tokens.js'
import { Kernel } from '@/kernel/kernel.js'
import { Topics } from '@/kernel/topics.js'
import { CONTRACT_VERSION } from '@/kernel/version.js'

import { ElectronAppSettingsStore } from './app-settings-store.js'
import { ElectronLoggingSettingsService } from './logging-settings-service.js'
import { ElectronProxySettingsService } from './proxy-settings-service.js'
import { createSessionFetch } from './session-fetch.js'
import { ThemeRegistryImpl } from './theme-registry.js'
import { createWindow, applyTitleBarColors } from './window.js'

let kernel: Kernel | null = null
let bridge: IpcBridge | null = null
/** Unsubscribes OS light/dark changes when the shell exits. */
let systemThemeUnsubscribe: (() => void) | null = null

/**
 * In GPU-less / virtualized environments (VMs, CI, remote desktop, restricted
 * sandboxes) the Chromium GPU process may crash repeatedly. Opt out explicitly
 * via `REM2_DISABLE_GPU=1`; disabled by default. Must be called before
 * `app.whenReady()`.
 *
 * The switches below are a matched set, not just GPU flags: on such hosts the
 * Chromium *process sandbox* fails the same way as the GPU stack - its
 * virtualization backend cannot create a shared context, so every renderer
 * process dies with an access violation (blank window, `loadFile` then fails
 * with ERR_FAILED). `no-sandbox` is therefore part of this opt-in path; the
 * default startup keeps the process sandbox, and the renderer still runs under
 * `contextIsolation` + the IPC whitelist + the kernel CapabilityGuard.
 */
if (process.env.REM2_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('disable-software-rasterizer')
  app.commandLine.appendSwitch('in-process-gpu')
  // Required on GPU-less / virtualized hosts: the Chromium process sandbox's
  // virtualization backend fails there ("Failed to create shared context for
  // virtualization"), which crashes every renderer process with an access
  // violation (blank window, ERR_FAILED on load). Only this opt-in path is
  // weakened; the default startup keeps the process sandbox. The renderer
  // still runs under contextIsolation + the IPC whitelist + CapabilityGuard.
  app.commandLine.appendSwitch('no-sandbox')
}

/** Host-side theme registry (theme catalog + selection, the service behind the `ui.theme` slot; imports no plugin). */
const themeRegistry = new ThemeRegistryImpl()

/**
 * Dimension-reduction mapping from kernel topics to external event names
 * (see `host/ipc/forward-map.ts`).
 *
 * The map keys are external event names; the whitelist comes from the single
 * source of truth in `shared/ipc-contract.ts`. Both the key set and topic
 * correctness are enforced at compile time (a missing key or a wrong topic
 * fails typecheck).
 */

/**
 * Register host implementations of whitelisted methods.
 *
 * The implementation table lives in `host/ipc/method-handlers.ts`: the key set
 * is enforced at compile time by `AllowedMethod`, and method-name strings
 * appear in exactly one place repo-wide (`shared/ipc-contract.ts`).
 * This file therefore contains no method-name strings — one less place to drift.
 */
function registerWhitelistedMethods(
  kernelRef: Kernel,
  pluginManager: LocalPluginManager,
  proxySettings: ProxySettingsService,
  appearanceSettings: AppearanceSettingsService,
  loggingSettings: LoggingSettingsService,
  market: RegistryMarketService,
): void {
  const bus = kernelRef.root.resolve<EventBus>(KernelTokens.EventBus)
  const methodContext = {
    kernel: kernelRef,
    bus,
    themeRegistry,
    isSystemDark: () => nativeTheme.shouldUseDarkColors,
    // The renderer reports the title bar's measured colors; the OS-painted
    // overlay cannot follow the renderer's CSS variables by itself.
    applyTitleBarOverlay: colors => {
      for (const win of BrowserWindow.getAllWindows()) {
        applyTitleBarColors(win, colors)
      }
    },
    pluginManager,
    market,
    proxySettings,
    appearanceSettings,
    loggingSettings,
    // Renderer dialogs are not a sufficient trust boundary: compromised renderer
    // code could invoke these methods directly. The main process asks the user
    // again using values it has validated.
    confirmPluginAction: async request => {
      const result = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Cancel', 'Continue'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: request.title,
        message: request.message,
        detail: request.detail,
      })
      return result.response === 1
    },
    choosePluginDirectory: async () => {
      const result = await dialog.showOpenDialog({
        title: 'Install a built plugin directory',
        buttonLabel: 'Install',
        properties: ['openDirectory'],
      })
      return result.canceled ? undefined : result.filePaths[0]
    },
  }
  const handlers = createMethodHandlers(methodContext)
  bus.respond(Topics.UiThemeRefresh, createThemeRefreshHandler(methodContext))
  for (const [method, handler] of Object.entries(handlers)) {
    // `null` = not implemented by the host (`command.execute` is responded by the command plugin itself).
    if (!handler) continue
    bus.respond(method, handler)
  }
}

async function startKernel(): Promise<void> {
  const userData = app.getPath('userData')
  // One app-level settings store for both namespaces. Proxy initialization loads
  // it before any network use; a corrupt file only loses the affected values
  // (the proxy falls back to the system proxy, the renderer to the OS color mode).
  const appSettings = new ElectronAppSettingsStore(userData)
  const proxySettings = new ElectronProxySettingsService(
    session.defaultSession,
    appSettings,
  )
  await proxySettings.initialize()
  // Proxy initialization loads the unified settings document; logging settings
  // are read from the same load and applied before the kernel starts.
  const logging = appSettings.getLogging()
  const appearanceSettings: AppearanceSettingsService = {
    get: () => appSettings.getAppearance(),
    set: settings => appSettings.setAppearance(settings),
  }
  /**
   * Host downloads and release metadata use Chromium's network stack (and thus
   * the configured proxy). `ClientRequest` is used instead of `net.fetch` so
   * manual redirects work and every hop can be validated against the allowlist.
   * Resolved here, after `app` is ready: `session.defaultSession` throws
   * before that.
   */
  const netFetch = createSessionFetch(session.defaultSession)
  const userRoot = path.join(userData, 'plugins')
  const builtinRoot = builtinPluginsRoot()
  const state = new PluginStateStore(path.join(userData, 'plugin-manager.json'))
  await state.load()
  // Remote provenance (source URL + published digest) is only readable here:
  // the renderer never sees paths, and all network/file work stays in main.
  const provenance = new PluginProvenanceStore(
    path.join(userData, 'plugin-provenance.json'),
  )
  await provenance.load()
  // Explicit capability grants for user plugins: the kernel applies them after
  // the trust-policy decision, so a sandboxed plugin only gets what the user
  // approved in the plugin manager.
  const grants = new PluginGrantStore(path.join(userData, 'plugin-grants.json'))
  await grants.load()
  // Uninstalled plugins keep a manifest + source record so the manager can list
  // them as NotInstalled and offer an Install action instead of dropping them.
  const removed = new PluginRemovedStore(
    path.join(userData, 'plugin-removed.json'),
  )
  await removed.load()
  // The kernel keeps this array by reference. Startup recovery may change the
  // disabled intent, so it is refreshed in place before kernel.start().
  const disabledPlugins = state.ids()

  kernel = new Kernel(
    createDeps({
      id: 'rem2-kernel-electron',
      roots: [userRoot],
      disabledPlugins,
      builtinRoot,
      grantedCapabilities: pluginId => grants.get(pluginId),
      pluginDataRoot: path.join(userData, 'plugin-data'),
      startTimeoutMs: 5000,
      stopTimeoutMs: 5000,
      legacyFallback: false,
      logLevel: logging.level,
      initialConfig: { app: { greeting: 'Hello from Electron shell' } },
    }),
  )

  // Host-provided UI-side service: exposed only via KernelTokens, never special-cased for any specific plugin.
  kernel.root.registerInstance(KernelTokens.UiThemeRegistry, themeRegistry)

  // Console logging is host-owned: install the sink before start() so plugin
  // startup logs are visible, and let the settings service add/remove it later.
  const log = kernel.root.resolve(KernelTokens.Log) as LogServiceLike
  const loggingSettings = new ElectronLoggingSettingsService(appSettings, log)
  if (logging.enabled) log.addSink(new ConsoleLogSink())

  const pluginManager = new LocalPluginManager({
    kernel,
    userRoot,
    dataRoot: path.join(userData, 'plugin-data'),
    state,
    builtinRoot,
    provenance,
    grants,
    removed,
    packagesRoot: path.join(userData, 'plugin-packages'),
    fetchImpl: netFetch,
    downloadRedirectMode: 'manual',
  })
  // Recover interrupted updates and stale staging before the kernel discovers
  // plugins; otherwise it could start a half-installed or missing version.
  await pluginManager.prepare()
  disabledPlugins.splice(0, disabledPlugins.length, ...state.ids())
  // The official marketplace is a host-side join of the registry index with
  // local install state; installation still goes through the same package
  // manager and verification path.
  const market = new RegistryMarketService({
    client: new RegistryClient({
      cache: new RegistryCache(path.join(userData, 'registry-cache.json')),
      fetchImpl: netFetch,
    }),
    manager: pluginManager,
    kernelVersion: kernel.version,
    contractVersion: CONTRACT_VERSION,
  })
  registerWhitelistedMethods(
    kernel,
    pluginManager,
    proxySettings,
    appearanceSettings,
    loggingSettings,
    market,
  )
  await kernel.start()

  const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus)
  bridge = new IpcBridge(bus, { forwardMap: EVENT_FORWARD_MAP })
  bridge.bind({
    send: (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(channel, payload)
      }
    },
    on: (channel, handler) => {
      const listener = (_e: unknown, payload: unknown): void => handler(payload)
      ipcMain.on(channel, listener)
      return () => ipcMain.removeListener(channel, listener)
    },
  })

  // The renderer owns the title bar's colors: it measures the bar and reports
  // them over the IPC contract, and `applyTitleBarOverlay` repaints the native
  // window controls. Nothing here re-derives colors from theme data, which
  // would fight the renderer and desync the overlay from the actual bar.

  const onSystemThemeChange = (): void => {
    const activeId = themeRegistry.active()
    if (!activeId || !themeRegistry.get(activeId)?.followSystem) return
    void bus
      .request(Topics.UiThemeRefresh, undefined)
      .catch(error =>
        console.error('[rem2-kernel] System theme refresh failed:', error),
      )
  }
  nativeTheme.on('updated', onSystemThemeChange)
  systemThemeUnsubscribe = () => {
    nativeTheme.removeListener('updated', onSystemThemeChange)
  }
}

/** Create the shell window (macOS reactivation included). */
function createAppWindow(): BrowserWindow {
  return createWindow()
}

// Must stay `.then`: Electron waits for the ESM entry module to finish evaluating
// before emitting `ready`, so a top-level `await app.whenReady()` would deadlock.
// Async work that must precede ready may be top-level awaited, but not this event.
app.whenReady().then(async () => {
  try {
    await startKernel()
  } catch (error) {
    // The shell is only a carrier, but a kernel startup failure must be
    // surfaced explicitly: otherwise it degrades into a silent unhandled
    // rejection — the user just sees "no window" with nothing to debug.
    const message = error instanceof Error ? error.message : String(error)
    console.error('[rem2-kernel] Kernel startup failed:', error)
    dialog.showErrorBox('rem2-kernel startup failed', message)
    app.quit()
    return
  }

  createAppWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createAppWindow()
  })
})

// Fallback: log any uncaught async error to avoid silent failures.
process.on('unhandledRejection', reason => {
  console.error('[rem2-kernel] Unhandled promise rejection:', reason)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  bridge?.unbind()
  systemThemeUnsubscribe?.()
  systemThemeUnsubscribe = null
  if (kernel) {
    await kernel.shutdown()
    kernel = null
  }
})
