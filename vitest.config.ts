import { defineConfig } from 'vitest/config'
import { KERNEL_ALIAS } from './vite.shared.mjs'

/**
 * Vitest configuration.
 *
 * - environment: node (the kernel is a pure Node library; it never depends on
 *   Electron or the DOM).
 * - pool: threads (good isolation, fast startup).
 * - alias rem2-kernel -> src/kernel/index.ts: shares one source with the vite
 *   configs, eliminating drift from declaring the same alias in several places.
 *
 * ## Concurrency and timeouts (important)
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
    environment: 'node',
    pool: 'threads',
    include: ['tests/**/*.test.ts'],
    globals: false,
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
  },
  resolve: {
    alias: {
      'rem2-kernel': KERNEL_ALIAS,
    },
  },
})
