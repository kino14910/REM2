/**
 * 插件脚手架（docs/02 §L.6 T05：开发者 CLI）。
 *
 * 用法：`pnpm cli scaffold <plugin-id> [--dir plugins] [--name "My Plugin"]`
 * 生成 `plugin.json` + `src/index.ts` 骨架。
 */

import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { KERNEL_VERSION } from '../kernel/version.js';

/** scaffold 选项。 */
export interface ScaffoldOptions {
  pluginId: string;
  name?: string;
  /** 输出根目录（默认 plugins）。 */
  dir?: string;
  /** 项目根（用于解析默认 dir）。 */
  projectRoot?: string;
}

/** scaffold 结果。 */
export interface ScaffoldResult {
  pluginDir: string;
  files: string[];
}

/** 生成 manifest 对象。 */
export function buildManifest(
  pluginId: string,
  name: string,
): Record<string, unknown> {
  const shortName = pluginId.split('.').slice(-1)[0] ?? pluginId;
  return {
    id: pluginId,
    name,
    version: '0.1.0',
    entry: 'src/index.ts',
    dependencies: {},
    optionalDependencies: {},
    capabilities: [`${shortName}.provide`],
    compatibility: {
      minKernel: `^${KERNEL_VERSION.split('.').slice(0, 2).join('.')}.0`,
      contractVersion: '1',
    },
    author: 'rem2-team',
    description: `${name} 插件（由 rem2 CLI 生成）`,
    tags: ['generated'],
  };
}

/** 生成插件源码骨架。 */
export function buildPluginSource(pluginId: string, name: string): string {
  return `/**
 * ${name} 插件（由 rem2 CLI 生成）。
 *
 * 只从公共出口 \`rem2-kernel\` 引用内核：类型 + 令牌。
 */

import type { Plugin, PluginContext, PluginManifest } from 'rem2-kernel';

export default class ${toClassName(name)}Plugin implements Plugin {
  readonly manifest: PluginManifest = {
    id: '${pluginId}',
    name: '${name}',
    version: '0.1.0',
    entry: 'src/index.ts',
    capabilities: ['${pluginId.split('.').slice(-1)[0] ?? pluginId}.provide'],
    compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
  };

  async onConfigure(ctx: PluginContext): Promise<void> {
    ctx.log.info('${pluginId} 配置完成');
  }

  async onStart(ctx: PluginContext): Promise<void> {
    ctx.log.info('${pluginId} 已启动');
  }

  async onStop(ctx: PluginContext, reason: string): Promise<void> {
    ctx.log.info(\`${pluginId} 已停止（\${reason}）\`);
  }
}
`;
}

function toClassName(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .split(' ')
      .filter(Boolean)
      .map((w) => w[0]!.toUpperCase() + w.slice(1))
      .join('') || 'Plugin'
  );
}

/**
 * 执行脚手架生成。
 */
export async function scaffoldPlugin(
  opts: ScaffoldOptions,
): Promise<ScaffoldResult> {
  const baseDir = opts.dir
    ? path.resolve(opts.projectRoot ?? process.cwd(), opts.dir)
    : path.resolve(opts.projectRoot ?? process.cwd(), 'plugins');
  const dirName = opts.pluginId.replace(/[^a-z0-9._-]/gi, '_');
  const pluginDir = path.join(baseDir, dirName);

  if (await pathExists(pluginDir)) {
    throw new Error(`目标目录已存在：${pluginDir}`);
  }

  await mkdir(path.join(pluginDir, 'src'), { recursive: true });

  const name = opts.name ?? opts.pluginId;
  const manifestPath = path.join(pluginDir, 'plugin.json');
  const sourcePath = path.join(pluginDir, 'src', 'index.ts');

  await writeFile(
    manifestPath,
    `${JSON.stringify(buildManifest(opts.pluginId, name), null, 2)}\n`,
    'utf8',
  );
  await writeFile(sourcePath, buildPluginSource(opts.pluginId, name), 'utf8');

  return { pluginDir, files: [manifestPath, sourcePath] };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
