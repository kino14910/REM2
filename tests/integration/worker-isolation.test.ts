/**
 * Integration test: worker thread isolation (docs/01 §9 D1:
 * process-level fault isolation).
 *
 * Scenarios:
 * 1. A plugin with `isolation: 'worker'` starts in a separate worker thread
 *    and responds to events.
 * 2. When the worker crashes (`process.exit(1)`) the kernel survives and the
 *    plugin is marked Failed.
 *
 * Test plugins are written in plain .mjs: there is no TS compiler pipeline
 * inside the worker thread.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Kernel } from '../../src/kernel/kernel.js'
import { makeManifest } from '../helpers/make-manifest.js'

/**
 * Materialize a worker plugin directory.
 *
 * The entry points at `dist/index.mjs` (the only supported form: build
 * output); the fixture writes its source there directly because there is
 * no TS compiler pipeline inside the worker.
 */
async function writeWorkerPlugin(
  root: string,
  id: string,
  source: string,
): Promise<void> {
  const dirName = id.replace(/[^a-z0-9._-]/gi, '_')
  const pluginDir = path.join(root, dirName)
  await mkdir(path.join(pluginDir, 'dist'), { recursive: true })
  const manifest = makeManifest({ id, entry: 'dist/index.mjs' })
  ;(manifest as { isolation?: string }).isolation = 'worker'
  await writeFile(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  )
  await writeFile(path.join(pluginDir, 'dist/index.mjs'), source, 'utf8')
}

describe('integration · worker isolation', () => {
  let root = ''
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-worker-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('the worker plugin starts normally and responds to events', async () => {
    // The plugin subscribes to echo:request in onStart and emits echo:reply.
    await writeWorkerPlugin(
      root,
      'com.rem2.worker-echo',
      `
export default function factory(ctx) {
  const unsubs = [];
  return {
    async onStart() {
      unsubs.push(
        ctx.events.on('echo:request', async (payload) => {
          await ctx.events.emit('echo:reply', { echo: payload });
        }),
      );
      ctx.log.info('worker echo started');
    },
    async onStop() {
      for (const u of unsubs) u();
      unsubs.length = 0;
    },
    onHealthCheck() { return 'healthy'; },
  };
}
`,
    )

    const kernel = new Kernel({ roots: [root] })
    const result = await kernel.start()
    expect(result.failed).toEqual([])
    expect(result.started).toContain('com.rem2.worker-echo')

    const loaded = kernel.pluginRegistry.getLoaded('com.rem2.worker-echo')
    expect(loaded?.state).toBe('Active')

    const bus = kernel.root.resolve<{
      emit(e: string, p?: unknown): Promise<void>
      once(p: string, h: (x: unknown) => void): () => void
    }>(
      (await import('../../src/kernel/contracts/kernel-tokens.js')).KernelTokens
        .EventBus,
    )
    const reply = new Promise<unknown>(resolve => {
      bus.once('echo:reply', resolve)
    })
    await bus.emit('echo:request', { msg: 'hello-worker' })
    const value = (await reply) as { echo: { msg: string } }
    expect(value.echo.msg).toBe('hello-worker')

    await kernel.shutdown()
  }, 15_000)

  it('worker crash → the kernel survives, the plugin is marked Failed', async () => {
    // The plugin calls process.exit(1) in onStart to simulate a crash.
    await writeWorkerPlugin(
      root,
      'com.rem2.worker-crash',
      `
export default function factory(ctx) {
  return {
    async onStart() {
      ctx.log.info('about to crash');
      // Exits the worker thread directly to simulate a crash.
      process.exit(1);
    },
  };
}
`,
    )

    const kernel = new Kernel({ roots: [root] })
    // process.exit in onStart makes the worker thread exit; the kernel should
    // treat the plugin as Failed instead of crashing itself.
    const result = await kernel.start()

    // The plugin fails, whether the hook threw or the worker exited unexpectedly.
    expect(result.failed).toContain('com.rem2.worker-crash')
    const loaded = kernel.pluginRegistry.getLoaded('com.rem2.worker-crash')
    expect(loaded?.state).toBe('Failed')

    // The kernel itself stays healthy (it can still produce a health report).
    const report = await kernel.health()
    expect(report.plugins.some(p => p.id === 'com.rem2.worker-crash')).toBe(
      true,
    )

    await kernel.shutdown()
  }, 15_000)
})
