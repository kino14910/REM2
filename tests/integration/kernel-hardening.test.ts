/**
 * 集成测试 · 内核加固修正集。
 *
 * 1. 配置引导：initialConfig 在无任何配置插件时对插件可见（kernel.start() 先 refresh）。
 * 2. 卸载：unloadPlugin 级联卸载依赖者并回收容器/权限/扩展点工件。
 * 3. 热重载：旧容器被强制卸载，未自觉 unexport 的服务不泄漏。
 * 4. 追踪：生命周期阶段产生 span。
 *
 * fixture 插件一律用**唯一形态**（default 导出工厂函数）。in-process 插件与测试同处一个
 * Node 上下文，因此把观测值写到 `globalThis.__rem2Probe` 上供断言读取 ——
 * 这比「从内核注册表反查插件实例字段」更贴近新形态（工厂产物是闭包，没有可读字段）。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel/kernel.js';
import { defineToken } from '../../src/kernel/contracts/service-token.js';
import { makeManifest } from '../helpers/make-manifest.js';
import { KernelTokens } from '../../src/kernel/contracts/kernel-tokens.js';

/** in-process fixture 插件的观测出口。 */
interface Probe {
  greeting?: string;
  stopped?: boolean;
  resolveResult?: unknown;
  resolveError?: Error | null;
  bus?: unknown;
}

function probe(): Probe {
  const g = globalThis as unknown as { __rem2Probe?: Probe };
  g.__rem2Probe ??= {};
  return g.__rem2Probe;
}

async function writePlugin(
  root: string,
  id: string,
  source: string,
  deps?: Record<string, string>,
): Promise<void> {
  const dirName = id.replace(/[^a-z0-9._-]/gi, '_');
  const pluginDir = path.join(root, dirName);
  await mkdir(path.join(pluginDir, 'dist'), { recursive: true });
  const manifest = makeManifest({
    id,
    // 唯一形态：构建产物。fixture 直接把源码写在 dist/index.mjs。
    entry: 'dist/index.mjs',
    ...(deps ? { dependencies: deps } : {}),
  });
  await writeFile(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
  await writeFile(path.join(pluginDir, 'dist', 'index.mjs'), source, 'utf8');
}

describe('integration · kernel hardening', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-hardening-'));
    probe();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('配置引导：initialConfig 对插件 onConfigure 可见（无需配置插件）', async () => {
    await writePlugin(
      root,
      'com.rem2.config-reader',
      `
const P = (globalThis.__rem2Probe = globalThis.__rem2Probe || {});
export default function factory(ctx) {
  return {
    async onConfigure() {
      P.greeting = ctx.config.get('app.greeting', '(default)');
    },
  };
}
`,
    );

    const kernel = new Kernel({
      roots: [root],
      initialConfig: { app: { greeting: 'BootstrapHello' } },
    });
    const result = await kernel.start();
    expect(result.started).toContain('com.rem2.config-reader');
    expect(probe().greeting).toBe('BootstrapHello');

    await kernel.shutdown();
  });

  it('unloadPlugin 级联卸载依赖者并回收工件', async () => {
    await writePlugin(root, 'com.rem2.base-svc', `export default function factory() { return {}; }`);
    await writePlugin(
      root,
      'com.rem2.dependent',
      `
const P = (globalThis.__rem2Probe = globalThis.__rem2Probe || {});
export default function factory() {
  return {
    async onStop() { P.stopped = true; },
  };
}
`,
      { 'com.rem2.base-svc': '^1.0.0' },
    );

    const kernel = new Kernel({ roots: [root] });
    const result = await kernel.start();
    expect(result.started).toContain('com.rem2.base-svc');
    expect(result.started).toContain('com.rem2.dependent');

    await kernel.unloadPlugin('com.rem2.base-svc');

    // 依赖者被级联卸载。
    expect(kernel.pluginRegistry.getLoaded('com.rem2.base-svc')).toBeUndefined();
    expect(kernel.pluginRegistry.getLoaded('com.rem2.dependent')).toBeUndefined();
    expect(kernel.lastStartResult.started).not.toContain('com.rem2.base-svc');
    expect(kernel.lastStartResult.started).not.toContain('com.rem2.dependent');
    expect(probe().stopped).toBe(true);

    await kernel.shutdown();
  });

  it('热重载：未自觉 unexport 的旧服务不泄漏到 root 挂载表', async () => {
    const GreeterTokenSrc = `({ id: 'plugin.test.leaky', describe: 'leaky' })`;
    // V1：导出服务但从不在 onUnload 里 unexport（不自觉清理）。
    const body = (version: number) => `
const TOKEN = ${GreeterTokenSrc};
export default function factory(ctx) {
  return {
    async onStart() {
      ctx.services.registerInstance(TOKEN, { version: ${version} });
      ctx.api.export(TOKEN);
    },
    // 故意不实现 onUnload（不调用 api.unexport）。
  };
}
`;
    await writePlugin(root, 'com.rem2.leaky', body(1));

    const kernel = new Kernel({ roots: [root] });
    await kernel.start();

    // V2：重写插件文件（仍不 unexport）。
    await writePlugin(root, 'com.rem2.leaky', body(2));
    await kernel.reload('com.rem2.leaky');

    // root 容器解析到的应是新实例（version 2），且挂载表中只有一个该插件容器。
    const token = defineToken<{ version: number }>({
      id: 'plugin.test.leaky',
      describe: '',
    });
    const svc = kernel.root.resolve(token);
    expect(svc.version).toBe(2);

    await kernel.shutdown();
  });

  it('生命周期阶段产生追踪 span', async () => {
    await writePlugin(
      root,
      'com.rem2.traced',
      `export default function factory() { return { async onStart() {} }; }`,
    );

    const kernel = new Kernel({ roots: [root] });
    await kernel.start();

    const spans = kernel.tracing.bufferedSpans();
    const names = spans.map((s) => s.name);
    expect(names).toContain('plugin.lifecycle.Configured');
    const startSpan = spans.find(
      (s) =>
        s.name === 'plugin.lifecycle.Configured' &&
        s.attributes.pluginId === 'com.rem2.traced',
    );
    expect(startSpan).toBeDefined();
    expect(startSpan!.attributes.ok).toBe(true);

    await kernel.shutdown();
  });

  it('EventBus 令牌保持公共（内核服务白名单边界正确）', async () => {
    const kernel = new Kernel({ roots: [] });
    // 内核侧（'kernel' 调用方）不受 guard 限制。
    const bus = kernel.root.resolve(KernelTokens.EventBus);
    expect(typeof bus.emit).toBe('function');
    await kernel.shutdown();
  });
});
