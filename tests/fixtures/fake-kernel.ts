/**
 * 测试 fixture：在临时目录物化一组可配置的内联插件源码，用于集成测试。
 *
 * 每个插件是**唯一形态**（`export default` 一个工厂函数）的纯 JS（不依赖内核类型）——
 * 这正是「形态收敛」在测试侧的体现：fixture 不需要引用 `rem2-kernel`。
 * manifest 由运行时钩子内联提供，但内核从 `plugin.json` 读取权威清单。
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
  /** 能力声明（我需要什么）。 */
  requires?: string[];
  /** 扩展点贡献（我提供什么）。 */
  contributes?: Array<{ point: string; id: string }>;
  /** onStart 行为。 */
  behavior?: 'ok' | 'throw' | { delayMs: number };
  /** 健康状态。 */
  health?: string;
}

/** 生成插件源码（ESM，default 导出工厂函数）。 */
function sourceFor(p: InlinePlugin): string {
  const behavior = p.behavior ?? 'ok';
  let startBody = '';
  if (behavior === 'throw') {
    startBody = `throw new Error('${p.id} start failed');`;
  } else if (typeof behavior === 'object') {
    startBody = `await new Promise((r) => setTimeout(r, ${behavior.delayMs}));`;
  }

  // 声明式贡献：把 manifest.contributes 逐条投到 ctx.extensions。
  const contributeLines = (p.contributes ?? [])
    .map(
      (c) =>
        `    ctx.extensions.contribute(${JSON.stringify(c.point)}, { contributionId: ${JSON.stringify(c.id)}, impl: { id: ${JSON.stringify(c.id)} } });`,
    )
    .join('\n');

  return `
export default function factory(ctx) {
  return {
    async onConfigure() { /* noop */ },
    async onStart() {
${startBody}
${contributeLines}
    },
    async onStop() { /* noop */ },
    async onUnload() { /* noop */ },
    async onDispose() { /* noop */ },
    onHealthCheck() { return ${JSON.stringify(p.health ?? 'healthy')}; },
  };
}
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
      ...(p.requires ? { requires: p.requires } : {}),
      ...(p.contributes ? { contributes: p.contributes } : {}),
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
