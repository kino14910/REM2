/**
 * `createWindow()`: window creation (including CSP and sandbox settings).
 *
 * Split out from `main.ts` because it owns the renderer security boundary:
 * - `contextIsolation: true` + `sandbox: true` → the renderer has no Node
 *   capabilities under contextIsolation.
 * - `preload: path.join(__dirname, 'preload.cjs')` — the file name is an
 *   implicit contract: `vite.preload.config.mts` must guarantee the build
 *   output is named `preload.cjs`.
 */

import { BrowserWindow } from 'electron'
import path from 'node:path'

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
  const window = new BrowserWindow({
    width: opts.width ?? 960,
    height: opts.height ?? 720,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      // The renderer runs Svelte (needs window/DOM) and sandbox still works:
      // under sandbox the preload keeps contextBridge and ipcRenderer,
      // while the renderer gets no Node capabilities — exactly what we want.
      sandbox: true,
    },
  })

  // Dev: load the Vite dev server (HMR). Packaged: load the renderer output.
  // The packaged path is `.vite/renderer/<name>/index.html`, NOT `.vite/build/`.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    )
  }

  return window
}
