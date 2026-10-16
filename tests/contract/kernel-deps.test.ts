/**
 * 契约测试：内核零第三方运行时依赖 + 依赖单向（docs/03 P1/P2、docs/06 §3.2）。
 *
 * 用例：
 * - R1 零第三方：`src/kernel/**` + `src/host/**`（排除 `host/electron/**`）
 *   的每个 import 必须是 `node:*` 或相对路径。
 * - R2 内核不反向依赖：`src/kernel/**` 不得 import `host` / `frontend` / `plugins`。
 * - R5 `dependencies` 为空。
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

/**
 * 递归收集目录下的 `.ts` 文件。
 *
 * 注意：这里**不**用「文件名是否含点」判断是否递归进子目录 —— 那种写法会让
 * 任何含点的目录名（如未来的 `v1.0/`）被静默跳过，从而「扫不到文件而静默通过」。
 * 只排除明确的非源码目录名。
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.vite', 'plugins-dist']);

async function collectTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (entry.endsWith('.ts')) {
      out.push(full);
    } else {
      // 目录（无扩展名）→ 递归。
      out.push(...(await collectTsFiles(full)));
    }
  }
  return out;
}

/**
 * 剥掉注释与**模板字面量**的内容（模板串本身替换为空串）。
 *
 * 为什么必须剥模板串：`scaffold-plugin.ts` 的 `buildPluginSource()` 里有一段
 * 生成插件源码的模板字符串，其中含有 `from 'rem2-kernel'` 字样 —— 它是**字符串内容**
 * 而不是 import。不剥离就会把「生成本身合规」误判成「引用了裸包名」。
 *
 * ★ 为什么**不能**剥单/双引号字符串：import 说明符本身就写在引号里，
 * 一旦把内容清空成正则无法匹配的 `''`，`extractSpecifiers()` 会对**每一个文件**
 * 返回空数组 —— 整条红线随之静默失效（曾真实发生：注入 `zod` 到
 * `src/kernel/**` 后测试仍全绿）。
 */
function stripLiterals(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

/** 提取文件中的 import/export-from 说明符。 */
function extractSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const code = stripLiterals(source);
  const re =
    /(?:import|export)\s+(?:type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) specs.push(spec);
  }
  return specs;
}

/** 判断说明符是否被允许（node: 内置或相对路径）。 */
function isAllowed(spec: string): boolean {
  if (spec.startsWith('.') || spec.startsWith('/')) return true;
  if (spec.startsWith('node:')) {
    return ALLOWED_NODE_BUILTINS.some(
      (b) => spec === b || spec.startsWith(`${b}/`),
    );
  }
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
  return false;
}

/** 收集 `src/host` 下除 `electron/` 外的全部 .ts（electron 允许 import electron）。 */
async function collectHostNonElectronFiles(): Promise<string[]> {
  const all = await collectTsFiles(path.join(PROJECT_ROOT, 'src', 'host'));
  return all.filter(
    (f) => !path.relative(PROJECT_ROOT, f).includes(`host${path.sep}electron${path.sep}`),
  );
}

describe('contract · 内核零第三方运行时依赖', () => {
  it('R1 · src/kernel 与 src/host（除 electron）不含第三方 import', async () => {
    const files = [
      ...(await collectTsFiles(path.join(PROJECT_ROOT, 'src', 'kernel'))),
      ...(await collectHostNonElectronFiles()),
    ];
    // 自检：扫描到的文件数必须超过阈值，否则说明路径写错、红线静默失效。
    expect(files.length).toBeGreaterThan(30);

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

  it('R5 · package.json dependencies 为空', async () => {
    const pkg = JSON.parse(
      await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });
});

describe('contract · 依赖方向单向', () => {
  it('R2 · src/kernel 不得反向依赖 host / frontend / plugins', async () => {
    const files = await collectTsFiles(path.join(PROJECT_ROOT, 'src', 'kernel'));
    expect(files.length).toBeGreaterThan(30);

    const FORBIDDEN = ['/host/', '/frontend/', '/plugins/'];
    const violations: Array<{ file: string; spec: string }> = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const spec of extractSpecifiers(source)) {
        const normalized = `/${spec.replace(/\\/g, '/')}/`;
        // 只看跨顶层目录的引用（`../host/...` 这类）；同层 `./x.js` 不受影响。
        if (spec.startsWith('.') && FORBIDDEN.some((f) => normalized.includes(f))) {
          violations.push({ file: path.relative(PROJECT_ROOT, file), spec });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

/**
 * 元测试：提取器本身的有效性自检。
 *
 * 为什么必须单独一组：R1/R2 的断言形式是「 violations 为空」，这在提取器**恒返回空数组**
 * 时同样成立 —— 红线会静默失效（曾真实发生：`stripLiterals()` 把引号字符串清成 `''`，
 * 导致注入 `zod` 到 `src/kernel/**` 后测试仍全绿）。
 *
 * 因此这里不断言「源码里没有违规」，而是断言**提取器在一个已知输入上确实提取得出来**。
 * 提取器一旦被改坏，本组立刻红，红线失效不会再次静默发生。
 */
describe('contract · 提取器自检（元测试）', () => {
  it('extractSpecifiers 能提取 import ... from的说明符', () => {
    expect(extractSpecifiers("import x from 'zod';")).toEqual(['zod']);
    expect(extractSpecifiers('import x from "zod";')).toEqual(['zod']);
  });

  it('覆盖 type-only / 副作用导入 / 动态 import / export-from 四种形态', () => {
    expect(extractSpecifiers("import type { A } from './a.js';")).toEqual(['./a.js']);
    expect(extractSpecifiers("import './side-effect.js';")).toEqual(['./side-effect.js']);
    expect(extractSpecifiers("const m = await import('node:path');")).toEqual(['node:path']);
    expect(extractSpecifiers("export { a } from './a.js';")).toEqual(['./a.js']);
  });

  it('剥离注释与模板串，但不剥引号串', () => {
    const source = [
      "// import a from 'zod';",
      "/* import b from 'zod'; */",
      "const t = `import c from 'zod';`;",
      "import d from 'zod';",
    ].join('\n');
    // 只应看到真实的那一条
    expect(extractSpecifiers(source)).toEqual(['zod']);
  });

  it('isAllowed 能识别合法与非法说明符', () => {
    for (const ok of ['node:path', './a.js', '../b.js', 'node:fs/promises']) {
      expect(isAllowed(ok)).toBe(true);
    }
    for (const bad of ['zod', 'svelte', 'rem2-kernel', 'electron']) {
      expect(isAllowed(bad)).toBe(false);
    }
  });
});
