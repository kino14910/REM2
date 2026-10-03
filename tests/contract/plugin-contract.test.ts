/**
 * 契约测试：插件只从公共出口 `rem2-kernel` 引用内核，禁止深链内部实现（docs/02 §K.3）。
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');

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
    if (entry.endsWith('.ts')) out.push(full);
    else if (!entry.includes('.')) out.push(...(await collectTsFiles(full)));
  }
  return out;
}

function extractSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)\s+(?:type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1]) specs.push(m[1]);
  }
  return specs;
}

describe('contract · 插件公共接口约束', () => {
  it('plugins/ 只从 rem2-kernel 与 node/相对路径导入', async () => {
    const files = await collectTsFiles(path.join(PROJECT_ROOT, 'plugins'));
    expect(files.length).toBeGreaterThan(0);

    const violations: Array<{ file: string; spec: string }> = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const spec of extractSpecifiers(source)) {
        const ok =
          spec === 'rem2-kernel' ||
          spec.startsWith('node:') ||
          spec.startsWith('.') ||
          spec.startsWith('/');
        if (!ok)
          violations.push({ file: path.relative(PROJECT_ROOT, file), spec });
      }
    }
    expect(violations).toEqual([]);
  });

  it('plugins/ 不得深链 src/kernel 内部实现', async () => {
    const files = await collectTsFiles(path.join(PROJECT_ROOT, 'plugins'));
    const violations: Array<{ file: string; spec: string }> = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const spec of extractSpecifiers(source)) {
        if (spec.includes('src/kernel') || spec.includes('kernel/')) {
          violations.push({ file: path.relative(PROJECT_ROOT, file), spec });
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
