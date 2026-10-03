/**
 * 集成测试 · 安全边界修正（动机 #7）。
 *
 * 场景：
 * 1. 插件入口逃逸（entry 指向 rootDir 之外）→ 加载失败 E_ENTRY_ESCAPE。
 * 2. 实例 manifest.id 与 plugin.json 不一致 → 加载失败 E_MANIFEST_MISMATCH。
 * 3. 内核敏感服务令牌被 CapabilityGuard 拦截（kernel.internals / kernel.config.admin）。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel/kernel.js';
import { makeManifest } from '../helpers/make-manifest.js';

async function writePlugin(
  root: string,
  id: string,
  source: string,
): Promise<void> {
  const dirName = id.replace(/[^a-z0-9._-]/gi, '_');
  const pluginDir = path.join(root, dirName);
  await mkdir(path.join(pluginDir, 'src'), { recursive: true });
  const manifest = makeManifest({ id, entry: 'src/index.mjs' });
  await writeFile(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
  await writeFile(path.join(pluginDir, 'src/index.mjs'), source, 'utf8');
}

describe('integration · security boundary fixes', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-sec-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('entry 逃逸出 rootDir → E_ENTRY_ESCAPE', async () => {
    // 在 rootDir 外放一个"恶意"入口文件。
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'rem2-sec-out-'));
    await writeFile(
      path.join(outsideDir, 'evil.mjs'),
      'export default class {}',
      'utf8',
    );

    const pluginDir = path.join(root, 'com.rem2.evil');
    await mkdir(path.join(pluginDir, 'src'), { recursive: true });
    const manifest = makeManifest({
      id: 'com.rem2.evil',
      entry: '../evil.mjs',
    });
    // 手动改 entry 为相对 rootDir 的逃逸路径
    manifest.entry = `../../${path.basename(outsideDir)}/evil.mjs`;
    await writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );
    await writeFile(
      path.join(pluginDir, 'src/index.mjs'),
      'export default class {}',
      'utf8',
    );

    const kernel = new Kernel({ roots: [root] });
    const result = await kernel.start();
    expect(result.failed).toContain('com.rem2.evil');
    // 入口逃逸在加载期即被拦截，插件从未进入注册表。
    expect(kernel.pluginRegistry.getLoaded('com.rem2.evil')).toBeUndefined();

    await kernel.shutdown();
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('实例 manifest.id 漂移 → E_MANIFEST_MISMATCH', async () => {
    await writePlugin(
      root,
      'com.rem2.mismatch',
      `
export default class MismatchPlugin {
  constructor() {
    this.manifest = { id: 'com.rem2.different-id', name: 'X', version: '1.0.0', entry: 'src/index.mjs', compatibility: { minKernel: '^1.0.0', contractVersion: '1' } };
  }
}
`,
    );

    const kernel = new Kernel({ roots: [root] });
    const result = await kernel.start();
    expect(result.failed).toContain('com.rem2.mismatch');
    await kernel.shutdown();
  });

  it('内核敏感服务令牌被 CapabilityGuard 拦截', async () => {
    // 插件尝试用 ctx.services.resolve 解析 kernel.internals 服务（Loader）。
    await writePlugin(
      root,
      'com.rem2.sensitive-probe',
      `
export default class SensitiveProbePlugin {
  constructor() {
    this.manifest = ${JSON.stringify(makeManifest({ id: 'com.rem2.sensitive-probe', entry: 'src/index.mjs' }))};
    this.result = null;
    this.error = null;
  }
  async onStart(ctx) {
    try {
      // Loader 属于 kernel.internals，未授权应被拒绝。
      this.result = ctx.services.resolve({ id: 'kernel.loader', describe: '' });
    } catch (e) {
      this.error = e;
    }
  }
}
`,
    );

    const kernel = new Kernel({ roots: [root] });
    const result = await kernel.start();

    // 插件启动了（正常走流程），但 resolve 被 guard 拒绝。
    expect(result.started).toContain('com.rem2.sensitive-probe');
    const loaded = kernel.pluginRegistry.getLoaded('com.rem2.sensitive-probe');
    expect(loaded).toBeDefined();
    const inst = loaded!.instance as unknown as {
      result: unknown;
      error: Error | null;
    };
    expect(inst.result).toBeNull();
    expect(inst.error).not.toBeNull();
    expect(inst.error?.message).toContain('kernel.internals');

    await kernel.shutdown();
  });

  it('公共内核服务（EventBus）无需能力即可解析', async () => {
    await writePlugin(
      root,
      'com.rem2.public-probe',
      `
export default class PublicProbePlugin {
  constructor() {
    this.manifest = ${JSON.stringify(makeManifest({ id: 'com.rem2.public-probe', entry: 'src/index.mjs' }))};
    this.bus = null;
  }
  async onStart(ctx) {
    // EventBus 是公共的，无能力要求。
    this.bus = ctx.services.resolve({ id: 'kernel.event-bus', describe: '' });
  }
}
`,
    );

    const kernel = new Kernel({ roots: [root] });
    const result = await kernel.start();
    expect(result.started).toContain('com.rem2.public-probe');
    const loaded = kernel.pluginRegistry.getLoaded('com.rem2.public-probe');
    const inst = loaded!.instance as unknown as { bus: unknown };
    expect(inst.bus).not.toBeNull();

    await kernel.shutdown();
  });
});
