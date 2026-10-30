import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
import process from 'node:process'
import path from 'node:path'
import { Kernel } from '../../kernel/kernel.js'
import { createDeps } from '../../kernel/composition.js'
import { KernelTokens } from '../../kernel/contracts/kernel-tokens.js'
import { Topics } from '../../kernel/topics.js'
import type { ThemeDefinition } from '../../kernel/contracts/ui.js'
import { IpcBridge } from '../ipc/bridge.js'
import { EVENT_FORWARD_MAP } from '../ipc/forward-map.js'
import {
  createMethodHandlers,
  createThemeRefreshHandler,
} from '../ipc/method-handlers.js'
import { builtinPluginsRoot } from '../cli/paths.js'
import { createWindow, applyTitleBarTheme } from './window.js'
import type { EventBus } from '../../kernel/contracts/event-bus.js'
import { ThemeRegistryImpl } from './theme-registry.js'
import { LocalPluginManager } from '../plugins/local-plugin-manager.js'
import { PluginStateStore } from '../plugins/state-store.js'
import { PluginProvenanceStore } from '../plugins/provenance-store.js'

let kernel: Kernel | null = null
let bridge: IpcBridge | null = null
/** Unsubscribes the native title-bar overlay from theme changes (see `startKernel`). */
let themeUnsubscribe: (() => void) | null = null
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
): void {
  const bus = kernelRef.root.resolve<EventBus>(KernelTokens.EventBus)
  const methodContext = {
    kernel: kernelRef,
    bus,
    themeRegistry,
    isSystemDark: () => nativeTheme.shouldUseDarkColors,
    pluginManager,
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

  kernel = new Kernel(
    createDeps({
      id: 'rem2-kernel-electron',
      roots: [userRoot],
      disabledPlugins: state.ids(),
      builtinRoot,
      pluginDataRoot: path.join(userData, 'plugin-data'),
      startTimeoutMs: 5000,
      stopTimeoutMs: 5000,
      legacyFallback: false,
      logLevel: 'info',
      initialConfig: { app: { greeting: 'Hello from Electron shell' } },
    }),
  )

  // Host-provided UI-side service: exposed only via KernelTokens, never special-cased for any specific plugin.
  kernel.root.registerInstance(KernelTokens.UiThemeRegistry, themeRegistry)

  const pluginManager = new LocalPluginManager({
    kernel,
    userRoot,
    dataRoot: path.join(userData, 'plugin-data'),
    state,
    builtinRoot,
    provenance,
    packagesRoot: path.join(userData, 'plugin-packages'),
  })
  registerWhitelistedMethods(kernel, pluginManager)
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

  // The window-controls overlay is painted by the OS, so it cannot follow the
  // renderer's CSS variables; drive it from the same topic that feeds the
  // renderer's `ui.theme.changed` event.
  themeUnsubscribe = bus.on(Topics.UiThemeChanged, payload => {
    const theme = (payload as ThemeDefinition | null) ?? null
    for (const win of BrowserWindow.getAllWindows()) {
      applyTitleBarTheme(win, theme)
    }
  })

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

/** Create the shell window, applying the active theme to the native overlay (macOS reactivation included). */
function createAppWindow(): BrowserWindow {
  const window = createWindow()
  const activeId = themeRegistry.active()
  applyTitleBarTheme(
    window,
    activeId ? (themeRegistry.get(activeId) ?? null) : null,
  )
  return window
}

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
  themeUnsubscribe?.()
  themeUnsubscribe = null
  systemThemeUnsubscribe?.()
  systemThemeUnsubscribe = null
  if (kernel) {
    await kernel.shutdown()
    kernel = null
  }
})
