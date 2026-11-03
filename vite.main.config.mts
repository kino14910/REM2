/**
 * Main-process build configuration.
 *
 * Shared bits (alias / conditions / sourcemap) come from `vite.shared.mts`.
 *
 * Output format is declared explicitly as an ESM library. Forge's Vite plugin
 * injects a CJS `build.lib` default only when `build.lib` is absent; declaring
 * it here keeps the main bundle native ESM (`main.mjs`) instead of `main.cjs`.
 *
 * `ssr.noExternal: true` is deliberate: Forge's Vite plugin restricts the
 * packaged files to `.vite`, so anything left external (electron-store and its
 * ESM-only dependency tree) would be unresolvable inside `app.asar`. Bundling
 * every runtime dependency keeps `main.mjs` self-contained and avoids Rollup
 * emitting `require()` for an ESM-only package; `electron` and Node built-ins
 * remain external.
 */

import { defineConfig } from 'vite'
import { NODE_SHARED } from './vite.shared.mjs'

export default defineConfig({
  ...NODE_SHARED,
  ssr: {
    ...NODE_SHARED.ssr,
    noExternal: true,
  },
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
    // Both main and preload emit into the same directory; each build must not
    // wipe the other target's artifact (Forge also sets this in its base config).
    emptyOutDir: false,
    lib: {
      entry: 'src/main.ts',
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.mjs`,
    },
    rollupOptions: {
      // electron is provided at runtime and must not be bundled.
      external: ['electron'],
      // Keep the forwarder-shell shape so forge.config.mts's entry needs no change.
      input: 'src/main.ts',
      output: {
        // `ssr` would otherwise default the entry name to `[name].js`; the explicit
        // `.mjs` extension makes Electron's ESM classification unambiguous.
        format: 'es',
        entryFileNames: '[name].mjs',
        chunkFileNames: '[name]-[hash].mjs',
      },
    },
  },
})
