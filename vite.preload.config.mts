/**
 * preload build configuration.
 *
 * The output name MUST be `preload.cjs`: `host/electron/window.ts` resolves
 * `preload.cjs` from the main module directory. Renaming it breaks preload
 * script loading, and the error message will not hint at the file name. This is
 * an implicit contract.
 *
 * The preload source is ESM TypeScript, but the artifact stays CJS on purpose:
 * a sandboxed preload script (`sandbox: true` + `contextIsolation: true`) is
 * loaded by Electron's CJS preload runtime and cannot use ESM imports.
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
    // Both main and preload emit into the same directory; each build must not
    // wipe the other target's artifact (Forge also sets this in its base config).
    emptyOutDir: false,
    rollupOptions: {
      external: ['electron'],
      input: 'src/preload.ts',
      output: {
        // preload must be CJS: sandboxed preload scripts run in Electron's
        // CommonJS preload loader and cannot import ESM.
        format: 'cjs',
        entryFileNames: '[name].cjs',
      },
    },
  },
})
