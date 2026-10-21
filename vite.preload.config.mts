/**
 * preload build configuration.
 *
 * The output name MUST be `preload.cjs`: `host/electron/window.ts` hardcodes
 * `path.join(__dirname, 'preload.cjs')`. Renaming it breaks preload script loading,
 * and the error message will not hint at the file name. This is an implicit contract.
 */

import { defineConfig } from 'vite'
import { NODE_SHARED } from './vite.shared.mjs'

export default defineConfig({
  ...NODE_SHARED,
  build: {
    ...NODE_SHARED.build,
    // Same as vite.main.config.mts: declare Node semantics, otherwise node: modules
    // get externalized as browser dependencies.
    ssr: 'src/preload.ts',
    // Must be set explicitly: Vite's default outDir is `dist`, which is the kernel
    // artifact directory (tsconfig.build.json's outDir). Sharing it would let the
    // preload build wipe the kernel artifacts.
    // .vite/build is also where forge's VitePlugin emits at package time.
    outDir: '.vite/build',
    rollupOptions: {
      external: ['electron'],
      input: 'src/preload.ts',
      output: {
        // preload must be CJS: contextBridge relies on CommonJS semantics.
        format: 'cjs',
        entryFileNames: '[name].cjs',
      },
    },
  },
})
