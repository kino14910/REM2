/**
 * Renderer build configuration — the ONLY config that mounts the svelte plugin.
 *
 * CSP compatible: Svelte 5's `$state` / `$derived` compile to plain JS, no `eval`
 * needed, so `index.html`'s `script-src 'self'` does not require `unsafe-eval`.
 */

import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { KERNEL_RESOLVE, KERNEL_BUILD } from './vite.shared.mjs'

export default defineConfig({
  // The renderer entry is index.html at the repo root (it references /src/frontend/entry-client.ts).
  root: '.',
  plugins: [svelte()],
  resolve: {
    // The frontend never imports the kernel in practice, but stay consistent to prevent misuse.
    ...KERNEL_RESOLVE,
    // Must be declared separately from NODE_CONDITIONS on the Node side.
    // `resolve.conditions` REPLACES the default set in Vite 8 (mergeWithDefaultsRecursively),
    // so browser semantics must be spelled out here; otherwise svelte's exports fall to the
    // server entry and `mount()` throws lifecycle_function_unavailable => white screen
    // (see vite.shared.mts).
    conditions: ['browser', 'import', 'module'],
  },
  build: {
    ...KERNEL_BUILD,
    // Match the Chromium version shipped with Electron 44.
    target: 'chrome120',
    // Must be set explicitly: Vite's default outDir is `dist`, which is the kernel
    // artifact directory (tsconfig.build.json's outDir). Sharing it would let the
    // renderer build wipe the kernel artifacts.
    // This directory is also where forge's VitePlugin emits at package time.
    outDir: '.vite/renderer/main_window',
    rollupOptions: {
      input: 'index.html',
    },
  },
  server: {
    fs: {
      // The svelte plugin needs to read .svelte / .ts sources under the project root.
      allow: ['.'],
    },
  },
})
