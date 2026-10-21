import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import process from 'node:process'
import { Kernel } from '../../kernel/kernel.js'
import { createDeps } from '../../kernel/composition.js'
import { KernelTokens } from '../../kernel/contracts/kernel-tokens.js'
import { IpcBridge } from '../ipc/bridge.js'
import { EVENT_FORWARD_MAP } from '../ipc/forward-map.js'
import { createMethodHandlers } from '../ipc/method-handlers.js'
import { builtinPluginsRoot } from '../cli/paths.js'
import { createWindow } from './window.js'
import type { EventBus } from '../../kernel/contracts/event-bus.js'
import { ThemeRegistryImpl } from './theme-registry.js'

let kernel: Kernel | null = null
let bridge: IpcBridge | null = null

/**
 * In GPU-less / virtualized environments (VMs, CI, remote desktop, restricted
 * sandboxes) the Chromium GPU process may crash repeatedly. Opt out explicitly
 * via `REM2_DISABLE_GPU=1`; disabled by default. Must be called before
 * `app.whenReady()`.
 */
if (process.env.REM2_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('disable-software-rasterizer')
  app.commandLine.appendSwitch('in-process-gpu')
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
function registerWhitelistedMethods(kernelRef: Kernel): void {
  const bus = kernelRef.root.resolve<EventBus>(KernelTokens.EventBus)
  const handlers = createMethodHandlers({
    kernel: kernelRef,
    bus,
    themeRegistry,
  })
  for (const [method, handler] of Object.entries(handlers)) {
    // `null` = not implemented by the host (`command.execute` is responded by the command plugin itself).
    if (!handler) continue
    bus.respond(method, handler)
  }
}

async function startKernel(): Promise<void> {
  kernel = new Kernel(
    createDeps({
      id: 'rem2-electron',
      roots: [],
      builtinRoot: builtinPluginsRoot(),
      startTimeoutMs: 5000,
      stopTimeoutMs: 5000,
      legacyFallback: false,
      logLevel: 'info',
      initialConfig: { app: { greeting: 'Hello from Electron shell' } },
    }),
  )

  // Host-provided UI-side service: exposed only via KernelTokens, never special-cased for any specific plugin.
  kernel.root.registerInstance(KernelTokens.UiThemeRegistry, themeRegistry)

  registerWhitelistedMethods(kernel)
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
}

app.whenReady().then(async () => {
  try {
    await startKernel()
  } catch (error) {
    // The shell is only a carrier, but a kernel startup failure must be
    // surfaced explicitly: otherwise it degrades into a silent unhandled
    // rejection — the user just sees "no window" with nothing to debug.
    const message = error instanceof Error ? error.message : String(error)
    console.error('[rem2] Kernel startup failed:', error)
    dialog.showErrorBox('rem2 kernel startup failed', message)
    app.quit()
    return
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Fallback: log any uncaught async error to avoid silent failures.
process.on('unhandledRejection', reason => {
  console.error('[rem2] Unhandled promise rejection:', reason)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  bridge?.unbind()
  if (kernel) {
    await kernel.shutdown()
    kernel = null
  }
})
