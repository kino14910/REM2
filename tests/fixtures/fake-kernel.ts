/**
 * 测试 fixture：在临时目录物化一组可配置的内联插件源码，用于集成测试。
 *
 * 每个插件为最小 JS（不依赖内核类型），通过 default 导出一个 plugin 实例，
 * manifest 由运行时钩子内联提供——但内核从 plugin.json 读取 manifest，
 * 因此这里同时写 plugin.json + index.js（ESM）。
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** 内联插件定义。 */
export interface InlinePlugin {
  id: string;
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  capabilities?: string[];
  /** onStart 行为。 */
  behavior?: 'ok' | 'throw' | { delayMs: number };
  /** 健康状态。 */
  health?: string;
}

/** 生成插件源码（ESM，default 导出实例）。 */
function sourceFor(p: InlinePlugin): string {
  const manifest = {
    id: p.id,
    name: p.name ?? p.id,
    version: p.version ?? '1.0.0',
    entry: 'index.js',
    compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
    ...(p.dependencies ? { dependencies: p.dependencies } : {}),
    ...(p.optionalDependencies
      ? { optionalDependencies: p.optionalDependencies }
      : {}),
    ...(p.capabilities ? { capabilities: p.capabilities } : {}),
  };

  const behavior = p.behavior ?? 'ok';
  let startBody = '';
  if (behavior === 'throw') {
    startBody = `throw new Error('${p.id} start failed');`;
  } else if (typeof behavior === 'object') {
    startBody = `await new Promise((r) => setTimeout(r, ${behavior.delayMs}));`;
  }

  return `
const manifest = ${JSON.stringify(manifest, null, 2)};
const plugin = {
  manifest,
  async onConfigure(ctx) { /* noop */ },
  async onStart(ctx) {
    ${startBody}
    if (ctx && ctx.api) {
      try { ctx.api.registerCapability('demo', true); } catch (e) {}
    }
  },
  async onStop(ctx, reason) { /* noop */ },
  async onUnload(ctx) { /* noop */ },
  async onDispose(ctx) { /* noop */ },
  onHealthCheck() { return ${JSON.stringify(p.health ?? 'healthy')}; },
};
export default plugin;
`;
}

/** 创建内联插件目录。 */
export async function materializePlugins(
  plugins: InlinePlugin[],
  prefix = 'rem2-fixture-',
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  for (const p of plugins) {
    const dir = path.join(root, p.id.replace(/[^a-z0-9._-]/gi, '_'));
    await mkdir(dir, { recursive: true });
    const manifest = {
      id: p.id,
      name: p.name ?? p.id,
      version: p.version ?? '1.0.0',
      entry: 'index.js',
      compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
      ...(p.dependencies ? { dependencies: p.dependencies } : {}),
      ...(p.optionalDependencies
        ? { optionalDependencies: p.optionalDependencies }
        : {}),
      ...(p.capabilities ? { capabilities: p.capabilities } : {}),
    };
    await writeFile(
      path.join(dir, 'plugin.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );
    await writeFile(path.join(dir, 'index.js'), sourceFor(p), 'utf8');
  }
  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}
