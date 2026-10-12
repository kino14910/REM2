/**
 * 插件脚手架（PRD P1-6 / docs/11 §9.1）。
 *
 * 生成物必须与新骨架**完全一致**，否则 scaffold 会立刻制造第二种真相：
 * ```
 * plugins/<dir>/
 *   package.json     type: module + esbuild build（产物落 dist/）
 *   tsconfig.json    只 paths 一条（无 rem2-kernel/* 通配）
 *   plugin.json      entry: dist/index.js（唯一形态）
 *   src/index.ts     export default definePlugin({...}, (ctx) => ({...}))
 * ```
 */

import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { KERNEL_VERSION } from '../../kernel/version.js';

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
    // ★ 唯一形态：构建产物，dev 与 prod 同值。
    entry: 'dist/index.js',
    dependencies: {},
    optionalDependencies: {},
    // 我提供什么：静态声明的扩展点贡献。
    contributes: [{ point: 'command.provide', id: shortName }],
    // 我需要什么：能力声明。
    requires: ['command.provide'],
    compatibility: {
      minKernel: `^${KERNEL_VERSION.split('.').slice(0, 2).join('.')}.0`,
      contractVersion: '1',
    },
    author: 'rem2-team',
    description: `${name} 插件（由 rem2 CLI 生成）`,
    tags: ['generated'],
  };
}

/** 生成插件 package.json（`@rem2/plugin-<dir>`，private，exports 指向 dist）。 */
export function buildPackageJson(dirName: string): string {
  const pkg = {
    name: `@rem2/plugin-${dirName}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    description: 'rem2 插件（由 CLI 生成）',
    main: './dist/index.js',
    exports: {
      '.': './dist/index.js',
    },
    scripts: {
      build: 'esbuild src/index.ts --bundle --format=esm --platform=node --target=node20 --outfile=dist/index.js',
      typecheck: 'tsc --noEmit -p tsconfig.json',
    },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** 生成插件 tsconfig.json（只有一条 paths，无 `rem2-kernel/*` 通配）。 */
export function buildTsConfig(): string {
  const cfg = {
    compilerOptions: {
      target: 'ESNext',
      lib: ['ESNext'],
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      // ★ emit 交给 esbuild；paths 只影响类型，产物里没有 rem2-kernel（被 bundle 内联）。
      noEmit: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      isolatedModules: true,
      types: ['node'],
      baseUrl: '.',
      // ★ 只有一条：让「插件只能从公共出口引用内核」成为类型级强制。
      paths: { 'rem2-kernel': ['../../src/kernel/index.ts'] },
    },
    include: ['src/**/*.ts'],
  };
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

/** 生成插件源码骨架（唯一形态：`export default definePlugin`）。 */
export function buildPluginSource(pluginId: string, name: string): string {
  const shortName = pluginId.split('.').slice(-1)[0] ?? pluginId;
  return `/**
 * ${name} 插件（由 rem2 CLI 生成）。
 *
 * 只从公共出口 \`rem2-kernel\` 引用内核：类型 + 令牌 + \`definePlugin\`。
 * 能力贡献走 \`ctx.extensions\`（扩展点注册表），不提供 Svelte 组件。
 */

import { definePlugin } from 'rem2-kernel';
import type { PluginContext } from 'rem2-kernel';

export default definePlugin(
  { id: '${pluginId}', name: '${name}', version: '0.1.0' },
  (ctx: PluginContext) => {
    const unsubs: Array<() => void> = [];

    return {
      async onConfigure(): Promise<void> {
        ctx.log.info('${pluginId} 配置完成');
        // 贡献扩展点（示意）：把实现挂到已声明的扩展点上。
        // ctx.extensions.contribute('command.provide', {
        //   contributionId: '${shortName}',
        //   impl: async (args) => ({ ok: true, echo: args }),
        // });
        void unsubs;
      },

      async onStart(): Promise<void> {
        ctx.log.info('${pluginId} 已启动');
      },

      async onStop(_ctx: PluginContext, reason: string): Promise<void> {
        for (const u of unsubs) u();
        unsubs.length = 0;
        ctx.log.info(\`${pluginId} 已停止（\${reason}）\`);
      },
    };
  },
);
`;
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
  const packagePath = path.join(pluginDir, 'package.json');
  const tsconfigPath = path.join(pluginDir, 'tsconfig.json');

  await writeFile(
    manifestPath,
    `${JSON.stringify(buildManifest(opts.pluginId, name), null, 2)}\n`,
    'utf8',
  );
  await writeFile(sourcePath, buildPluginSource(opts.pluginId, name), 'utf8');
  await writeFile(packagePath, buildPackageJson(dirName), 'utf8');
  await writeFile(tsconfigPath, buildTsConfig(), 'utf8');

  return {
    pluginDir,
    files: [manifestPath, sourcePath, packagePath, tsconfigPath],
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
