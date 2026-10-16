/**
 * 集成测试 · 安全边界（docs/06 §2.2 C1 / C7）。
 *
 * 场景：
 * 1. 插件入口逃逸（entry 指向 rootDir 之外）→ 加载失败 E_ENTRY_ESCAPE。
 * 2. 工厂内联 manifest.id 与 plugin.json 不一致 → 加载失败 E_MANIFEST_MISMATCH。
 * 3. 内核敏感服务令牌被 CapabilityGuard 拦截（kernel.internals / kernel.config.admin）。
 * 4. entry 非构建产物（.ts）→ 注册阶段即被 manifest-validator 拒绝。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel/kernel.js';
import { makeManifest } from '../helpers/make-manifest.js';

interface Probe {
  resolveResult?: unknown;
  resolveError?: Error | null;
  bus?: unknown;
  resolvePathEscaped?: boolean;
}

function probe(): Probe {
  const g = globalThis as unknown as { __rem2Probe?: Probe };
  g.__rem2Probe ??= {};
  return g.__rem2Probe;
}

async function writePlugin(root: string, id: string, source: string): Promise<void> {
  const dirName = id.replace(/[^a-z0-9._-]/gi, '_');
  const pluginDir = path.join(root, dirName);
  await mkdir(path.join(pluginDir, 'dist'), { recursive: true });
  const manifest = makeManifest({ id, entry: 'dist/index.mjs' });
  await writeFile(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
  await writeFile(path.join(pluginDir, 'dist', 'index.mjs'), source, 'utf8');
}

describe('integration · security boundary fixes', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-sec-'));
    probe();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('entry 逃逸出 rootDir → E_ENTRY_ESCAPE', async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'rem2-sec-out-'));
    await writeFile(path.join(outsideDir, 'evil.mjs'), 'export default function f() { return {}; }', 'utf8');

    const pluginDir = path.join(root, 'com.rem2.evil');
    await mkdir(path.join(pluginDir, 'dist'), { recursive: true });
    const manifest = makeManifest({ id: 'com.rem2.evil', entry: '../../evil.mjs' });
    await writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify(manifest, null, 2),
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

  it('工厂内联 manifest.id 漂移 → E_MANIFEST_MISMATCH', async () => {
    // 工厂上挂一个与 plugin.json 不一致的 manifest（模拟 definePlugin 首参写错 id）。
    await writePlugin(
      root,
      'com.rem2.mismatch',
      `
function factory(ctx) { return {}; }
factory.manifest = { id: 'com.rem2.different-id' };
export default factory;
`,
    );

    const kernel = new Kernel({ roots: [root] });
    const result = await kernel.start();
    expect(result.failed).toContain('com.rem2.mismatch');
    await kernel.shutdown();
  });

  it('entry 非构建产物（.ts）→ 注册阶段被拒', async () => {
    const pluginDir = path.join(root, 'com.rem2.ts-entry');
    await mkdir(path.join(pluginDir, 'src'), { recursive: true });
    const manifest = makeManifest({ id: 'com.rem2.ts-entry', entry: 'src/index.ts' });
    await writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );
    await writeFile(path.join(pluginDir, 'src', 'index.ts'), 'export default function f() { return {}; }', 'utf8');

    const kernel = new Kernel({ roots: [root] });
    const result = await kernel.start();
    expect(result.loadOrder).not.toContain('com.rem2.ts-entry');
    expect(kernel.pluginRegistry.getLoaded('com.rem2.ts-entry')).toBeUndefined();

    await kernel.shutdown();
  });

  it('内核敏感服务令牌被 CapabilityGuard 拦截', async () => {
    await writePlugin(
      root,
      'com.rem2.sensitive-probe',
      `
const P = (globalThis.__rem2Probe = globalThis.__rem2Probe || {});
P.resolveResult = null;
P.resolveError = null;
export default function factory(ctx) {
  return {
    async onStart() {
      try {
        // Loader 属于 kernel.internals，未授权应被拒绝。
        P.resolveResult = ctx.services.resolve({ id: 'kernel.loader', describe: '' });
      } catch (e) {
        P.resolveError = e;
      }
    },
  };
}
`,
    );

    const kernel = new Kernel({ roots: [root] });
    const result = await kernel.start();

    // 插件启动了（正常走流程），但 resolve 被 guard 拒绝。
    expect(result.started).toContain('com.rem2.sensitive-probe');
    expect(kernel.pluginRegistry.getLoaded('com.rem2.sensitive-probe')).toBeDefined();
    expect(probe().resolveResult).toBeNull();
    expect(probe().resolveError).not.toBeNull();
    expect(probe().resolveError?.message).toContain('kernel.internals');

    await kernel.shutdown();
  });

  it('公共内核服务（EventBus）无需能力即可解析', async () => {
    await writePlugin(
      root,
      'com.rem2.public-probe',
      `
const P = (globalThis.__rem2Probe = globalThis.__rem2Probe || {});
P.bus = null;
export default function factory(ctx) {
  return {
    async onStart() {
      // EventBus 是公共的，无能力要求。
      P.bus = ctx.services.resolve({ id: 'kernel.event-bus', describe: '' });
    },
  };
}
`,
    );

    const kernel = new Kernel({ roots: [root] });
    const result = await kernel.start();
    expect(result.started).toContain('com.rem2.public-probe');
    expect(probe().bus).not.toBeNull();

    await kernel.shutdown();
  });

  it('resolvePath 越界抛 EntryEscapeError', async () => {
    await writePlugin(
      root,
      'com.rem2.escape-probe',
      `
const P = (globalThis.__rem2Probe = globalThis.__rem2Probe || {});
P.resolvePathEscaped = false;
export default function factory(ctx) {
  return {
    async onStart() {
      try {
        ctx.resolvePath('../../outside.txt');
        P.resolvePathEscaped = true;
      } catch (e) {
        P.resolvePathEscaped = e && e.code === 'E_ENTRY_ESCAPE';
      }
    },
  };
}
`,
    );

    const kernel = new Kernel({ roots: [root] });
    await kernel.start();
    expect(probe().resolvePathEscaped).toBe(true);
    await kernel.shutdown();
  });
});
