#!/usr/bin/env node
/**
 * 插件构建：遍历 plugins 下的每个插件，逐个调 esbuild API，
 * 产物聚合到 plugins-dist/<插件名>/。
 *
 * 属于构建期代码（不进 src/），因此不违反「内核零第三方依赖」红线。
 *
 * 为什么产物要聚合，而不是就地放在各插件目录下：
 * forge.config.mts 的 extraResource 需要一个干净的目录 —— plugins 里还有
 * 源码目录、tsconfig.json、package.json，一起进包既臃肿又把源码泄进了安装包。
 *
 * 用法：node scripts/build-plugins.mjs [--out-dir <dir>]
 */

import { build } from 'esbuild';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const PLUGINS_DIR = path.join(PROJECT_ROOT, 'plugins');

/** esbuild 目标：Node 20（对齐 `engines.node: '>=20'`）。 */
const ESBUILD_TARGET = 'node20';

/** 从 argv 取 `--out-dir`，缺省 plugins-dist。 */
function parseOutDir(argv) {
  const i = argv.indexOf('--out-dir');
  return i >= 0 && argv[i + 1] ? path.resolve(PROJECT_ROOT, argv[i + 1]) : path.join(PROJECT_ROOT, 'plugins-dist');
}

/** 定位插件的入口源码：优先读 `plugin.json` 的 entry，回落到 `src/index.ts` / `src/index.mjs`。 */
async function resolveEntrySource(pluginDir) {
  const manifestPath = path.join(pluginDir, 'plugin.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const entry = typeof manifest.entry === 'string' ? manifest.entry : '';
    // `dist/index.js` → `src/index.ts`（源码在 src，产物在 dist，这是 entry 的语义）。
    const srcCandidate = entry.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
    if (entry.startsWith('dist/') && existsSync(path.join(pluginDir, srcCandidate))) {
      return srcCandidate;
    }
    if (entry && existsSync(path.join(pluginDir, entry))) return entry;
  }
  for (const candidate of ['src/index.ts', 'src/index.mjs', 'src/index.js']) {
    if (existsSync(path.join(pluginDir, candidate))) return candidate;
  }
  return undefined;
}

async function main() {
  const outDir = parseOutDir(process.argv.slice(2));
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  let entries;
  try {
    entries = (await readdir(PLUGINS_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .sort();
  } catch {
    process.stderr.write(`未找到插件目录：${PLUGINS_DIR}\n`);
    process.exitCode = 1;
    return;
  }

  let built = 0;
  const failures = [];

  for (const name of entries) {
    const pluginDir = path.join(PLUGINS_DIR, name);
    const source = await resolveEntrySource(pluginDir);
    if (!source) {
      failures.push(`${name}: 找不到入口源码（src/index.ts）`);
      continue;
    }

    const outPluginDir = path.join(outDir, name);
    await mkdir(path.join(outPluginDir, 'dist'), { recursive: true });

    try {
      await build({
        entryPoints: [path.join(pluginDir, source)],
        outfile: path.join(outPluginDir, 'dist', 'index.js'),
        bundle: true,
        // ESM：与内核 `type: module` 及 entry 的 `.js` 形态一致。
        format: 'esm',
        platform: 'node',
        target: ESBUILD_TARGET,
        // node:* 保持外部；插件不得引入第三方依赖（契约测试 R4 强制），
        // 因此这里**不设** external 白名单 —— 若真引了第三方包，应该在契约层先被拒。
        sourcemap: true,
        logLevel: 'silent',
      });

      // plugin.json 与产物一起进包：内核从插件目录读清单，缺了它就发现不了插件。
      await cp(path.join(pluginDir, 'plugin.json'), path.join(outPluginDir, 'plugin.json'));

      // 一份最小 package.json，让 Node 把产物当 ESM 解析（type: module）。
      await writeFile(
        path.join(outPluginDir, 'package.json'),
        `${JSON.stringify({ name: `rem2-plugin-${name}`, private: true, type: 'module', main: './dist/index.js' }, null, 2)}\n`,
        'utf8',
      );

      built += 1;
      process.stdout.write(`  ✓ ${name} → ${path.relative(PROJECT_ROOT, outPluginDir)}\n`);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }

  process.stdout.write(`插件构建完成：${built}/${entries.length}\n`);
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`  ✗ ${f}\n`);
    process.exitCode = 1;
  }
}

await main();
