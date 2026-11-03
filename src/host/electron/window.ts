/**
 * `createWindow()`: window creation (including CSP and sandbox settings).
 *
 * Split out from `main.ts` because it owns the renderer security boundary:
 * - `contextIsolation: true` + `sandbox: true` → the renderer has no Node
 *   capabilities under contextIsolation.
 * - `preload: path.join(moduleDirectory(), 'preload.cjs')` — the file name is an
 *   implicit contract: `vite.preload.config.mts` must guarantee the build
 *   output is named `preload.cjs`.
 *
 * Custom title bar (Electron "Custom Title Bar" tutorial): the native title
 * bar is removed with `titleBarStyle: 'hidden'` and the renderer draws the bar
 * (`frontend/app/components/TitleBar.svelte`). On Windows/Linux the native
 * window controls are kept via `titleBarOverlay`, so no custom
 * minimize/maximize/close buttons are needed; on macOS the traffic lights stay
 * visible. The overlay height must equal the bar height in CSS
 * (`TITLE_BAR_HEIGHT` ↔ `--rem2-titlebar-height`).
 *
 * Because the overlay is OS-painted it cannot read CSS variables; the renderer
 * measures the bar and reports its colors (`ui.titlebar.colors`), so the native
 * buttons always follow the theme that is currently applied.
 */

import { BrowserWindow } from 'electron'
import path from 'node:path'
import process from 'node:process'
import { moduleDirectory } from '@/host/cli/paths.js'

export interface TitleBarColors {
  /** CSS color filling the window-controls area. */
  color: string
  /** CSS color of the minimize/maximize/close glyphs. */
  symbolColor: string
}

/** Renderer title bar height; the Windows/Linux overlay takes an integer and must match it. */
export const TITLE_BAR_HEIGHT = 36

/**
 * Overlay colors used before the renderer reports the real bar colors. They are
 * the rendered dark-mode values of the title bar tokens (`themes/rem.css`), so
 * first paint does not flash a differently colored block in the corner.
 */
const INITIAL_OVERLAY_COLORS: TitleBarColors = {
  color: '#222222',
  symbolColor: '#858585',
}

/**
 * Apply renderer-measured colors to the window-controls overlay (Windows/Linux).
 *
 * The overlay is painted by the OS, so it does not follow the renderer's CSS
 * variables: the renderer measures its title bar and reports the colors over
 * `ui.titlebar.colors`, keeping the native buttons on the active theme.
 *
 * No-op on macOS: the traffic lights are native and carry their own colors.
 */
export function applyTitleBarColors(
  window: BrowserWindow,
  colors: TitleBarColors,
): void {
  if (process.platform === 'darwin') return
  window.setTitleBarOverlay({
    ...colors,
    height: TITLE_BAR_HEIGHT,
  })
}

/**
 * Compile-time constants injected by the Electron Forge Vite plugin (not
 * runtime environment variables).
 *
 * Important: Forge replaces bare identifiers via Vite's `define`, so you must
 * write `MAIN_WINDOW_VITE_DEV_SERVER_URL` directly — NOT
 * `process.env.MAIN_WINDOW_VITE_DEV_SERVER_URL`. The latter is never replaced
 * and stays undefined at runtime, making the window always take the `file://`
 * branch.
 */
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined
/** Renderer name (used in packaged builds to locate `.vite/renderer/<name>/index.html`). */
declare const MAIN_WINDOW_VITE_NAME: string

export interface CreateWindowOptions {
  width?: number
  height?: number
}

export function createWindow(opts: CreateWindowOptions = {}): BrowserWindow {
  const hostDir = moduleDirectory()
  const window = new BrowserWindow({
    width: opts.width ?? 960,
    height: opts.height ?? 720,
    backgroundColor: '#0f1115',
    // Remove the OS title bar; the renderer draws its own (`TitleBar.svelte`).
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 11 } }
      : {
          titleBarOverlay: {
            ...INITIAL_OVERLAY_COLORS,
            height: TITLE_BAR_HEIGHT,
          },
        }),
    webPreferences: {
      preload: path.join(hostDir, 'preload.cjs'),
      contextIsolation: true,
      // The renderer runs Svelte (needs window/DOM) and sandbox still works:
      // under sandbox the preload keeps contextBridge and ipcRenderer,
      // while the renderer gets no Node capabilities — exactly what we want.
      sandbox: true,
    },
  })

  // With `titleBarStyle: 'hidden'` Electron also hides the default menu bar, which
  // used to carry the "Toggle Developer Tools" accelerator; bind F12 explicitly
  // so the console stays reachable. `toggle` keeps it a close/open key.
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F12') return
    window.webContents.toggleDevTools()
    event.preventDefault()
  })

  // Dev: load the Vite dev server (HMR). Packaged: load the renderer output.
  // The packaged path is `.vite/renderer/<name>/index.html`, NOT `.vite/build/`.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
  } else {
    void window.loadFile(
      path.join(hostDir, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    )
  }

  return window
}
