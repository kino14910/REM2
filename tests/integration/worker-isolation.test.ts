/**
 * 集成测试 · Worker 线程隔离（docs/02 §C.6，动机 #6 进程级错误隔离）。
 *
 * 场景：
 * 1. `isolation: 'worker'` 的插件在独立 Worker 线程中启动并响应事件。
 * 2. Worker 崩溃（`process.exit(1)`）时内核不崩，插件被标记为 Failed。
 *
 * 测试插件用纯 .mjs 编写：Worker 线程内没有 TS 编译管线。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel/kernel.js';
import { PluginState } from '../../src/kernel/types.js';
import { makeManifest } from '../helpers/make-manifest.js';

/** 物化一个 worker 插件目录。 */
async function writeWorkerPlugin(
  root: string,
  id: string,
  source: string,
): Promise<void> {
  const dirName = id.replace(/[^a-z0-9._-]/gi, '_');
  const pluginDir = path.join(root, dirName);
  await mkdir(path.join(pluginDir, 'src'), { recursive: true });
  const manifest = makeManifest({ id, entry: 'src/index.mjs' });
  (manifest as { isolation?: string }).isolation = 'worker';
  await writeFile(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
  await writeFile(path.join(pluginDir, 'src/index.mjs'), source, 'utf8');
}

describe('integration · worker isolation', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-worker-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('worker 插件正常启动并响应事件', async () => {
    // 插件在 onStart 中订阅 echo:request 并回发 echo:reply。
    await writeWorkerPlugin(
      root,
      'com.rem2.worker-echo',
      `
export default class EchoPlugin {
  constructor() {
    this.manifest = ${JSON.stringify(makeManifest({ id: 'com.rem2.worker-echo', entry: 'src/index.mjs' }))};
    this.manifest.isolation = 'worker';
    this.unsubs = [];
  }
  async onStart(ctx) {
    this.unsubs.push(
      ctx.events.on('echo:request', async (payload) => {
        await ctx.events.emit('echo:reply', { echo: payload });
      }),
    );
    ctx.log.info('worker echo 已启动');
  }
  async onStop() {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }
  onHealthCheck() { return 'healthy'; }
}
`,
    );

    const kernel = new Kernel({ roots: [root] });
    const result = await kernel.start();
    expect(result.failed).toEqual([]);
    expect(result.started).toContain('com.rem2.worker-echo');

    const loaded = kernel.pluginRegistry.getLoaded('com.rem2.worker-echo');
    expect(loaded?.state).toBe(PluginState.Started);

    // 触发一次事件，验证 worker 内的订阅被调用并回发。
    const bus = kernel.root.resolve<{
      emit(e: string, p?: unknown): Promise<void>;
      once(p: string, h: (x: unknown) => void): () => void;
    }>(
      (await import('../../src/kernel/contracts/kernel-tokens.js')).KernelTokens
        .EventBus,
    );
    const reply = new Promise<unknown>((resolve) => {
      bus.once('echo:reply', resolve);
    });
    await bus.emit('echo:request', { msg: 'hello-worker' });
    const value = (await reply) as { echo: { msg: string } };
    expect(value.echo.msg).toBe('hello-worker');

    await kernel.shutdown();
  }, 15_000);

  it('worker 崩溃 → 内核不崩，插件标记为 Failed', async () => {
    // 插件在 onStart 中直接调用 process.exit(1) 模拟崩溃。
    await writeWorkerPlugin(
      root,
      'com.rem2.worker-crash',
      `
export default class CrashPlugin {
  constructor() {
    this.manifest = ${JSON.stringify(makeManifest({ id: 'com.rem2.worker-crash', entry: 'src/index.mjs' }))};
    this.manifest.isolation = 'worker';
  }
  async onStart(ctx) {
    ctx.log.info('即将崩溃');
    // 直接退出 Worker 线程，模拟崩溃。
    process.exit(1);
  }
}
`,
    );

    const kernel = new Kernel({ roots: [root] });
    // onStart 中 process.exit 会使 Worker 线程退出；内核应把它视为 Failed 而不是自己崩溃。
    const result = await kernel.start();

    // 插件失败（无论是钩子里的错误，还是 Worker 意外退出）。
    expect(result.failed).toContain('com.rem2.worker-crash');
    const loaded = kernel.pluginRegistry.getLoaded('com.rem2.worker-crash');
    expect(loaded?.state).toBe(PluginState.Failed);

    // 内核仍然健康（可生成健康报告）。
    const report = await kernel.health();
    expect(report.plugins.some((p) => p.id === 'com.rem2.worker-crash')).toBe(
      true,
    );

    await kernel.shutdown();
  }, 15_000);
});
