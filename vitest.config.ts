import { svelte } from '@sveltejs/vite-plugin-svelte'
import { playwright } from '@vitest/browser-playwright'
import { configDefaults, defineConfig } from 'vitest/config'

import { KERNEL_RESOLVE } from './vite.shared.mjs'

/**
 * Vitest configuration: two projects sharing one alias table.
 *
 * - `node`: the kernel, host and contract suites. Pure Node, no DOM, and the
 *   only project that feeds coverage (`src/kernel/**`).
 * - `browser`: Svelte component tests driven by Playwright/Chromium. A real
 *   browser is required because the components depend on runes, CSS custom
 *   properties and native events — jsdom would assert against a DOM that the
 *   packaged app never uses.
 *
 * Coverage lives at the root but `test:coverage` scopes it to `--project=node`,
 * so instrumenting `.svelte` files never slows the gate down.
 *
 * ## Concurrency and timeouts (node project)
 *
 * Every integration case materializes a temp plugin directory, boots a real
 * kernel (with timers and timeout guards), shuts down in reverse order, then
 * recursively deletes the temp directory. These cases are doubly heavy on CPU
 * and Windows file IO. Running them all in parallel under the default
 * concurrency (= CPU cores) starves them against each other, surfacing as
 * `Hook timed out in 15000ms` (the afterEach temp-dir cleanup timing out) —
 * NOT a real defect.
 * Measured: default concurrency took 86s of transform time with 5 files
 * timing out; capped at maxWorkers=2 it dropped to 1.9s with all 26 files /
 * 203 tests green.
 *
 * So the worker count is capped explicitly and timeouts loosened, keeping
 * results deterministic (independent of the machine's core count).
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/kernel/**/*.ts'],
      // index.ts is pure re-export, contracts is pure types, definitions is a
      // pure declaration table — counting them in coverage is meaningless.
      exclude: [
        'src/kernel/index.ts',
        'src/kernel/contracts/**',
        'src/kernel/extensions/definitions.ts',
      ],
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 85,
        branches: 80,
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          pool: 'threads',
          include: ['tests/**/*.test.ts'],
          // The browser suite lives under tests/browser; importing
          // `vitest/browser` outside Browser Mode throws at import time.
          exclude: [...configDefaults.exclude, 'tests/browser/**'],
          globals: false,
          maxWorkers: 4,
          // Projects with different worker counts need distinct group order,
          // otherwise Vitest cannot schedule them (node runs first).
          sequence: { groupOrder: 1 },
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        plugins: [svelte()],
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.ts'],
          globals: false,
          sequence: { groupOrder: 2 },
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
  resolve: {
    alias: KERNEL_RESOLVE.alias,
  },
})
