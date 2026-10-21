/**
 * Main-process build configuration.
 *
 * Shared bits (alias / conditions / ssr.noExternal / sourcemap) come from `vite.shared.mts`.
 * `ssr.noExternal: ['rem2-kernel']` is the critical entry: default externalization would
 * leave `require('rem2-kernel')` in the bundle, and at package time resolving to the
 * `.ts` entry fails with `ERR_UNKNOWN_FILE_EXTENSION`. That error only shows up
 * after packaging, never in dev mode.
 */

import { defineConfig } from 'vite'
import { NODE_SHARED } from './vite.shared.mjs'

export default defineConfig({
  ...NODE_SHARED,
  build: {
    ...NODE_SHARED.build,
    // Must be declared as an SSR (Node) build: otherwise Vite treats it as a browser
    // client build and externalizes node:fs / node:worker_threads, making the bundle
    // unusable in the Electron main process.
    // (Forge's VitePlugin injects this at real package time too; spelling it out here
    //   keeps the config self-consistent: running `vite build --config vite.main.config.mts`
    //   standalone also produces a correct bundle.)
    ssr: 'src/main.ts',
    // Must be set explicitly: Vite's default outDir is `dist`, which is the kernel
    // artifact directory (tsconfig.build.json's outDir). Sharing it would let the
    // main-process build wipe the kernel artifacts.
    // .vite/build is also where forge's VitePlugin emits at package time.
    outDir: '.vite/build',
    rollupOptions: {
      // electron is provided at runtime and must not be bundled.
      external: ['electron'],
      // Keep the forwarder-shell shape so forge.config.mts's entry needs no change.
      input: 'src/main.ts',
    },
  },
})
