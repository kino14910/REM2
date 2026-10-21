/**
 * Shared Vite config: the SINGLE SOURCE for alias and build/ssr strategy.
 *
 * All three vite configs and `vitest.config.ts` derive from here, eliminating the
 * drift risk of declaring the same alias three times.
 *
 * Note: `resolve.conditions` is deliberately NOT in the shared section — it
 * diverges per target environment (Node vs browser); see `KERNEL_RESOLVE`.
 *
 * The most critical entry is `ssr.noExternal: ['rem2-kernel']`:
 * Vite externalizes bare package names by default, so the main-process bundle keeps
 * `require('rem2-kernel')`; at package time that resolves through `exports` to the
 * `.ts` entry => `ERR_UNKNOWN_FILE_EXTENSION`.
 * This error only surfaces after packaging — in dev (in-memory bundle) it is invisible.
 */

import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'vite'

/** Absolute path to the kernel public entry (every config targets the same file). */
export const KERNEL_ALIAS = fileURLToPath(
  new URL('./src/kernel/index.ts', import.meta.url),
)

/**
 * Shared resolve section: the kernel is handled as SOURCE, with `.js` -> `.ts` falling
 * back to Vite 8's built-in resolution.
 *
 * Only the alias lives here, NOT conditions.
 * `resolve.conditions` REPLACES the default set in Vite 8 (mergeWithDefaultsRecursively:
 * non-object values are assigned directly, not merged), so declaring it here would make
 * the renderer lose `browser` from DEFAULT_CLIENT_CONDITIONS. And `node` implies `worker`
 * per the Node spec, so svelte's exports would hit the `worker` key first =>
 * index-server.js => `mount()` throws `lifecycle_function_unavailable` and the renderer
 * goes white. Conditions are split per target environment; see NODE_CONDITIONS and the
 * renderer config.
 */
export const KERNEL_RESOLVE = {
  alias: {
    'rem2-kernel': KERNEL_ALIAS,
  },
} satisfies UserConfig['resolve']

/**
 * Resolution conditions for the Node side (main / preload).
 *
 * Spelled out instead of relying on DEFAULT_SERVER_CONDITIONS: the kernel needs
 * deterministic Node semantics when its `exports` conditions apply, unaffected by
 * changes to Vite's defaults.
 */
export const NODE_CONDITIONS = ['node', 'import', 'module']

/** Shared build section. `target` is overridden per config (main/preload=node20, renderer=chrome120). */
export const KERNEL_BUILD = {
  sourcemap: true,
  minify: false,
} satisfies UserConfig['build']

/** Shared ssr section (used by main / preload). */
export const KERNEL_SSR = {
  noExternal: ['rem2-kernel'],
} satisfies UserConfig['ssr']

/** Shared Node-side fragment (main / preload). */
export const NODE_SHARED = {
  resolve: {
    ...KERNEL_RESOLVE,
    conditions: NODE_CONDITIONS,
  },
  ssr: KERNEL_SSR,
  build: {
    ...KERNEL_BUILD,
    target: 'node20' as const,
  },
} satisfies UserConfig
