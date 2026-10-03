/**
 * Manifest 校验 CLI（docs/02 §L.6 T05）。
 *
 * 用法：`pnpm cli validate <plugin-dir | plugin.json>`。
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { validateManifest } from '../kernel/discovery/manifest-validator.js';

/** 校验结果条目。 */
export interface ValidateEntry {
  file: string;
  ok: boolean;
  issues: string[];
}

/** 校验单个 manifest 文件。 */
export async function validateManifestFile(
  filePath: string,
): Promise<ValidateEntry> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    return {
      file: filePath,
      ok: false,
      issues: [`解析失败：${(error as Error).message}`],
    };
  }
  const result = validateManifest(raw);
  return {
    file: filePath,
    ok: result.ok,
    issues: result.issues.map((i) => `${i.path}: ${i.message}`),
  };
}

/** 校验目标（plugin.json 文件 | 单个插件目录 | 含多个插件的父目录）。 */
export async function validateTarget(target: string): Promise<ValidateEntry[]> {
  const abs = path.resolve(target);
  const st = await stat(abs);

  if (st.isFile()) {
    return [await validateManifestFile(abs)];
  }

  // 情况一：目标目录本身就是一个插件（含 plugin.json）。
  const selfManifest = path.join(abs, 'plugin.json');
  if (await exists(selfManifest)) {
    return [await validateManifestFile(selfManifest)];
  }

  // 情况二：目标目录是"父目录"，逐个下探子目录的 plugin.json。
  const entries: ValidateEntry[] = [];
  const children = await readdir(abs);
  for (const child of children.sort()) {
    const manifestPath = path.join(abs, child, 'plugin.json');
    if (!(await exists(manifestPath))) continue;
    entries.push(await validateManifestFile(manifestPath));
  }
  return entries;
}

/** 路径是否存在（不抛错）。 */
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** CLI 入口。 */
export async function runValidate(argv: string[]): Promise<number> {
  const target = argv[0];
  if (!target) {
    process.stderr.write('用法：validate <plugin-dir | plugin.json>\n');
    return 2;
  }

  const entries = await validateTarget(target);
  if (entries.length === 0) {
    process.stderr.write(`未找到可校验的 plugin.json：${target}\n`);
    return 2;
  }

  let failed = 0;
  for (const entry of entries) {
    if (entry.ok) {
      process.stdout.write(`✓ ${entry.file}\n`);
    } else {
      failed += 1;
      process.stderr.write(`✗ ${entry.file}\n`);
      for (const issue of entry.issues) {
        process.stderr.write(`    - ${issue}\n`);
      }
    }
  }
  process.stdout.write(
    `\n校验完成：${entries.length - failed}/${entries.length} 通过\n`,
  );
  return failed === 0 ? 0 : 1;
}
