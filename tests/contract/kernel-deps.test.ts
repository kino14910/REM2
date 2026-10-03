/**
 * 契约测试：内核零第三方运行时依赖（docs/02 §B.2 红线 / §K.3）。
 *
 * 静态扫描 `src/kernel/**` 与 `src/runtime/**` 的所有 import：
 * 仅允许 node: 内置模块与内核自身相对路径；禁止任何第三方包导入。
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');

/** 允许的 node 内置模块前缀。 */
const ALLOWED_NODE_BUILTINS = [
  'node:path',
  'node:fs',
  'node:fs/promises',
  'node:events',
  'node:worker_threads',
  'node:url',
  'node:process',
  'node:os',
  'node:module',
  'node:assert',
  'node:http',
  'node:net',
  'node:stream',
  'node:crypto',
  'node:util',
];

/** 扫描目录下全部 .ts 文件。 */
async function collectTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (entry.endsWith('.ts')) {
      out.push(full);
    } else if (!entry.includes('.')) {
      out.push(...(await collectTsFiles(full)));
    }
  }
  return out;
}

/** 提取文件中的 import/export-from 说明符。 */
function extractSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:import|export)\s+(?:type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) specs.push(spec);
  }
  return specs;
}

/** 判断说明符是否被允许。 */
function isAllowed(spec: string): boolean {
  // 相对/绝对路径 → 内核自身
  if (spec.startsWith('.') || spec.startsWith('/')) return true;
  // node: 内置
  if (spec.startsWith('node:')) {
    return ALLOWED_NODE_BUILTINS.some(
      (b) => spec === b || spec.startsWith(`${b}/`),
    );
  }
  // 裸 node 内置（无前缀）
  const bareBuiltins = [
    'path',
    'fs',
    'events',
    'process',
    'os',
    'url',
    'assert',
    'module',
    'http',
    'net',
    'stream',
    'crypto',
    'util',
  ];
  if (bareBuiltins.includes(spec)) return true;
  // 其他一律视为第三方
  return false;
}

describe('contract · 内核零第三方运行时依赖', () => {
  it('src/kernel 与 src/runtime 不含第三方 import', async () => {
    const files = [
      ...(await collectTsFiles(path.join(PROJECT_ROOT, 'src', 'kernel'))),
      ...(await collectTsFiles(path.join(PROJECT_ROOT, 'src', 'runtime'))),
    ];
    expect(files.length).toBeGreaterThan(10);

    const violations: Array<{ file: string; spec: string }> = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const spec of extractSpecifiers(source)) {
        if (!isAllowed(spec)) {
          violations.push({ file: path.relative(PROJECT_ROOT, file), spec });
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('package.json dependencies 为空', async () => {
    const pkg = JSON.parse(
      await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });
});
