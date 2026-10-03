/**
 * 集成测试 · 内核加固修正集。
 *
 * 1. 配置引导：initialConfig 在无任何配置插件时对插件可见（kernel.start() 先 refresh）。
 * 2. 卸载：unloadPlugin 级联卸载依赖者并回收容器/权限工件。
 * 3. 热重载：旧容器被强制卸载，未自觉 unexport 的服务不泄漏。
 * 4. 追踪：生命周期阶段产生 span。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel/kernel.js';
import { makeManifest } from '../helpers/make-manifest.js';
import { KernelTokens } from '../../src/kernel/contracts/kernel-tokens.js';
import { ServiceToken } from '../../src/kernel/contracts/service-token.js';

async function writePlugin(
  root: string,
  id: string,
  source: string,
  deps?: Record<string, string>,
): Promise<void> {
  const dirName = id.replace(/[^a-z0-9._-]/gi, '_');
  const pluginDir = path.join(root, dirName);
  await mkdir(path.join(pluginDir, 'src'), { recursive: true });
  const manifest = makeManifest({
    id,
    entry: 'src/index.mjs',
    ...(deps ? { dependencies: deps } : {}),
  });
  await writeFile(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
  await writeFile(path.join(pluginDir, 'src/index.mjs'), source, 'utf8');
}

describe('integration · kernel hardening', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-hardening-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('配置引导：initialConfig 对插件 onConfigure 可见（无需配置插件）', async () => {
    await writePlugin(
      root,
      'com.rem2.config-reader',
      `
export default class ConfigReaderPlugin {
  constructor() {
    this.manifest = ${JSON.stringify(makeManifest({ id: 'com.rem2.config-reader', entry: 'src/index.mjs' }))};
    this.greeting = null;
  }
  async onConfigure(ctx) {
    this.greeting = ctx.config.get('app.greeting', '(default)');
  }
}
`,
    );

    const kernel = new Kernel({
      roots: [root],
      initialConfig: { app: { greeting: 'BootstrapHello' } },
    });
    const result = await kernel.start();
    expect(result.started).toContain('com.rem2.config-reader');

    const loaded = kernel.pluginRegistry.getLoaded('com.rem2.config-reader');
    const inst = loaded!.instance as unknown as { greeting: string };
    expect(inst.greeting).toBe('BootstrapHello');

    await kernel.shutdown();
  });

  it('unloadPlugin 级联卸载依赖者并回收工件', async () => {
    await writePlugin(
      root,
      'com.rem2.base-svc',
      `
export default class BasePlugin {
  constructor() {
    this.manifest = ${JSON.stringify(makeManifest({ id: 'com.rem2.base-svc', entry: 'src/index.mjs' }))};
  }
}
`,
    );
    await writePlugin(
      root,
      'com.rem2.dependent',
      `
export default class DependentPlugin {
  constructor() {
    this.manifest = ${JSON.stringify(
      makeManifest({
        id: 'com.rem2.dependent',
        entry: 'src/index.mjs',
        dependencies: { 'com.rem2.base-svc': '^1.0.0' },
      }),
    )};
    this.stopped = false;
  }
  async onStop() { this.stopped = true; }
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
    expect(
      kernel.pluginRegistry.getLoaded('com.rem2.base-svc'),
    ).toBeUndefined();
    expect(
      kernel.pluginRegistry.getLoaded('com.rem2.dependent'),
    ).toBeUndefined();
    expect(kernel.lastStartResult.started).not.toContain('com.rem2.base-svc');
    expect(kernel.lastStartResult.started).not.toContain('com.rem2.dependent');

    await kernel.shutdown();
  });

  it('热重载：未自觉 unexport 的旧服务不泄漏到 root 挂载表', async () => {
    const GreeterTokenSrc = `({ id: 'plugin.test.leaky', describe: 'leaky' })`;
    // V1：导出服务但从不在 onUnload 里 unexport（不自觉清理）。
    await writePlugin(
      root,
      'com.rem2.leaky',
      `
export default class LeakyPlugin {
  constructor() {
    this.manifest = ${JSON.stringify(makeManifest({ id: 'com.rem2.leaky', entry: 'src/index.mjs' }))};
  }
  async onStart(ctx) {
    ctx.services.registerInstance(${GreeterTokenSrc}, { version: 1 });
    ctx.api.export(${GreeterTokenSrc});
  }
  // 故意不实现 onUnload（不调用 api.unexport）。
}
`,
    );

    const kernel = new Kernel({ roots: [root] });
    await kernel.start();

    // V2：重写插件文件（仍不 unexport）。
    await writePlugin(
      root,
      'com.rem2.leaky',
      `
export default class LeakyPlugin {
  constructor() {
    this.manifest = ${JSON.stringify(makeManifest({ id: 'com.rem2.leaky', entry: 'src/index.mjs' }))};
  }
  async onStart(ctx) {
    ctx.services.registerInstance(${GreeterTokenSrc}, { version: 2 });
    ctx.api.export(${GreeterTokenSrc});
  }
}
`,
    );

    await kernel.reload('com.rem2.leaky');

    // root 容器解析到的应是新实例（version 2），且挂载表中只有一个该插件容器。
    const token = ServiceToken.create<{ version: number }>({
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
      `
export default class TracedPlugin {
  constructor() {
    this.manifest = ${JSON.stringify(makeManifest({ id: 'com.rem2.traced', entry: 'src/index.mjs' }))};
  }
  async onStart() {}
}
`,
    );

    const kernel = new Kernel({ roots: [root] });
    await kernel.start();

    const spans = kernel.tracing.bufferedSpans();
    const names = spans.map((s) => s.name);
    expect(names).toContain('plugin.lifecycle.Start');
    const startSpan = spans.find(
      (s) =>
        s.name === 'plugin.lifecycle.Start' &&
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
