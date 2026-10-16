/**
 * 开发者 CLI 入口（docs/01 T05）。
 *
 * 用法：`pnpm cli <command> [args]`
 *   scaffold <plugin-id> [--dir <dir>] [--name "<name>"]  生成插件骨架
 *   validate <plugin-dir | plugin.json>                   校验 manifest
 *   list                                                  列出内建插件
 *   help                                                  帮助
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { scaffoldPlugin } from './scaffold-plugin.js';
import { runValidate } from './validate-manifest.js';
import { builtinPluginsRoot, projectRoot } from './paths.js';

/** CLI 主入口，返回退出码。 */
export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'scaffold': {
      const { id, opts } = parseScaffoldArgs(rest);
      if (!id) {
        process.stderr.write(
          '用法：scaffold <plugin-id> [--dir <dir>] [--name "<name>"]\n',
        );
        return 2;
      }
      try {
        const result = await scaffoldPlugin({ pluginId: id, ...opts });
        process.stdout.write(`已生成插件：${result.pluginDir}\n`);
        for (const f of result.files) process.stdout.write(`  - ${f}\n`);
        return 0;
      } catch (error) {
        process.stderr.write(`生成失败：${(error as Error).message}\n`);
        return 1;
      }
    }

    case 'validate':
      return await runValidate(rest);

    case 'list':
      return await listPlugins();

    case 'help':
    case undefined:
      printHelp();
      return 0;

    default:
      process.stderr.write(`未知命令：${command}\n`);
      printHelp();
      return 2;
  }
}

function parseScaffoldArgs(args: string[]): {
  id?: string;
  opts: { dir?: string; name?: string; projectRoot?: string };
} {
  const opts: { dir?: string; name?: string; projectRoot?: string } = {
    projectRoot: projectRoot(),
  };
  let id: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--dir') {
      opts.dir = args[++i];
    } else if (arg === '--name') {
      opts.name = args[++i];
    } else if (!id && !arg.startsWith('--')) {
      id = arg;
    }
  }
  return { id, opts };
}

async function listPlugins(): Promise<number> {
  const root = builtinPluginsRoot();
  let entries: string[];
  try {
    const st = await stat(root);
    if (!st.isDirectory()) throw new Error('not a directory');
    entries = await readdir(root);
  } catch {
    process.stderr.write(`未找到内建插件目录：${root}\n`);
    return 1;
  }
  const plugins: string[] = [];
  for (const entry of entries.sort()) {
    try {
      await stat(path.join(root, entry, 'plugin.json'));
      plugins.push(entry);
    } catch {
      // skip
    }
  }
  process.stdout.write(`内建插件（${plugins.length}）：\n`);
  for (const p of plugins) process.stdout.write(`  - ${p}\n`);
  return 0;
}

function printHelp(): void {
  process.stdout.write(
    [
      'rem2 开发者 CLI',
      '',
      '用法：pnpm cli <command> [args]',
      '',
      '命令：',
      '  scaffold <plugin-id> [--dir <dir>] [--name "<name>"]   生成插件骨架',
      '  validate <plugin-dir | plugin.json>                    校验 manifest',
      '  list                                                   列出内建插件',
      '  help                                                   显示帮助',
      '',
    ].join('\n'),
  );
}

// 直接执行。
const entry = process.argv[1] ?? '';
if (entry.endsWith('cli.ts') || entry.endsWith('cli.js')) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
