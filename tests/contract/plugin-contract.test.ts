/**
 * 契约测试：插件与前端的公共接口约束（docs/06 §3.2）。
 *
 * 用例：
 * - R4-1 插件只从 `rem2-kernel` / `node:*` / 相对路径导入。
 * - R4-2 禁止 `rem2-kernel/` 前缀（深链内核实现）—— 删掉根 tsconfig 的通配后
 *       这已是类型级强制，这里是第二道防线。
 * - R6 前端不碰内核：`src/frontend/**` 不得 import `rem2-kernel` / `src/kernel` / `src/host`。
 * - R7 manifest 形态：每个 plugin.json 的 entry 必须是构建产物（.js 或 .mjs 结尾）。
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Topics } from '../../src/kernel/topics.js';
import {
  ALLOWED_EVENTS,
  ALLOWED_EVENT_SET,
  ALLOWED_METHODS,
  ALLOWED_METHOD_SET,
} from '../../src/host/ipc/channels.js';
import { EVENT_FORWARD_MAP } from '../../src/host/ipc/forward-map.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.vite',
  'plugins-dist',
]);

/** 递归收集 `.ts` / `.svelte` 文件。 */
async function collectSourceFiles(dir: string): Promise<string[]> {
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
    if (entry.endsWith('.ts') || entry.endsWith('.svelte')) {
      out.push(full);
    } else {
      out.push(...(await collectSourceFiles(full)));
    }
  }
  return out;
}

/**
 * 剥掉注释与**模板字面量**的内容。
 *
 * `.svelte` 文件里常有模板字符串（如内联的 JS 示例），其中出现的
 * `rem2-kernel` 是**文本内容**而非 import，不剥离会误判 R6。
 *
 * ★ 不能剥单/双引号字符串：import 说明符就写在引号里，清空内容会让
 * `extractSpecifiers()` 对每个文件都返回 `[]`，R4/R6 随之静默失效。
 */
function stripLiterals(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

/** 提取 import 说明符（含 .svelte 的 from './X.svelte'）。 */
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

describe('contract · 插件公共接口约束', () => {
  it('R4-1 · plugins/*/src 只从 rem2-kernel 与 node:/相对路径导入', async () => {
    // 扫描范围明确为 `plugins/*/src/**`：dist 是构建产物，不参与源码边界判定。
    const files: string[] = [];
    let pluginDirs: string[] = [];
    try {
      pluginDirs = (
        await readdir(path.join(PROJECT_ROOT, 'plugins'), {
          withFileTypes: true,
        })
      )
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      pluginDirs = [];
    }
    for (const d of pluginDirs) {
      files.push(
        ...(await collectSourceFiles(
          path.join(PROJECT_ROOT, 'plugins', d, 'src'),
        )),
      );
    }
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
        if (!ok) {
          violations.push({ file: path.relative(PROJECT_ROOT, file), spec });
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('R4-2 · 插件不得深链内核实现（禁 rem2-kernel/ 前缀）', async () => {
    const files: string[] = [];
    const pluginDirs = (
      await readdir(path.join(PROJECT_ROOT, 'plugins'), { withFileTypes: true })
    )
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const d of pluginDirs) {
      files.push(
        ...(await collectSourceFiles(
          path.join(PROJECT_ROOT, 'plugins', d, 'src'),
        )),
      );
    }

    const violations: Array<{ file: string; spec: string }> = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const spec of extractSpecifiers(source)) {
        if (spec.startsWith('rem2-kernel/') || spec.includes('src/kernel')) {
          violations.push({ file: path.relative(PROJECT_ROOT, file), spec });
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('R7 · plugins/*/plugin.json 的 entry 以 .js 或 .mjs 结尾', async () => {
    const pluginRoot = path.join(PROJECT_ROOT, 'plugins');
    const dirs = (await readdir(pluginRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(dirs.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const d of dirs) {
      const manifestPath = path.join(pluginRoot, d, 'plugin.json');
      let manifest: { entry?: string };
      try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
          entry?: string;
        };
      } catch {
        violations.push(`${d}: plugin.json 缺失或无法解析`);
        continue;
      }
      const entry = manifest.entry ?? '';
      if (!/\.(js|mjs)$/.test(entry)) {
        violations.push(`${d}: entry 不是构建产物 → ${entry}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('contract · 前端不碰内核', () => {
  it('R6 · src/frontend 不得 import rem2-kernel / src/kernel / src/host', async () => {
    const files = await collectSourceFiles(
      path.join(PROJECT_ROOT, 'src', 'frontend'),
    );
    expect(files.length).toBeGreaterThan(5);

    const violations: Array<{ file: string; spec: string }> = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const spec of extractSpecifiers(source)) {
        const normalized = `/${spec.replace(/\\/g, '/')}/`;
        if (
          spec === 'rem2-kernel' ||
          spec.startsWith('rem2-kernel/') ||
          normalized.includes('/src/kernel/') ||
          normalized.includes('/src/host/')
        ) {
          violations.push({ file: path.relative(PROJECT_ROOT, file), spec });
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

/**
 * 契约的**第三判据**：把「内核 topic 真值」与「IPC 白名单」对上号。
 *
 * ★ 为什么必须有这一组（曾真实失效）：
 * `host/ipc/channels.ts` 的白名单与 `frontend/lib/channels.ts` 的镜像各手抄一份，
 * 两侧互相比对只能证明「它们相同」，**不能证明它们正确** —— 同时改错依然全绿。
 * 而 `EVENT_FORWARD_MAP` 是唯一同时接触「内核 Topics 真值」与「对外事件名」的地方，
 * 抽成独立文件（`host/ipc/forward-map.ts`）后才能在这里被断言。
 */
describe('contract · 内核 topic 与 IPC 白名单一致', () => {
  it('ALLOWED_METHODS 与 ALLOWED_METHOD_SET 内容一致且无重复', () => {
    expect(ALLOWED_METHOD_SET.size).toBe(ALLOWED_METHODS.length);
    expect(new Set(ALLOWED_METHODS).size).toBe(ALLOWED_METHODS.length);
  });

  it('ALLOWED_EVENTS 与 ALLOWED_EVENT_SET 内容一致且无重复', () => {
    expect(ALLOWED_EVENT_SET.size).toBe(ALLOWED_EVENTS.length);
    expect(new Set(ALLOWED_EVENTS).size).toBe(ALLOWED_EVENTS.length);
  });

  it('命令方法名必须等于内核 Topics.CommandExecute 的真值', () => {
    // 这是 command.execute 自递归缺陷的判据：桥用白名单名去 request，
    // 若它与内核 topic 不同名，就会「无响应者」或（更糟）自递归。
    expect(ALLOWED_METHOD_SET.has(Topics.CommandExecute)).toBe(true);
  });

  it('EVENT_FORWARD_MAP 的每个 topic 都是 Topics 里的真值', () => {
    const known = new Set<string>(Object.values(Topics));
    for (const f of EVENT_FORWARD_MAP) {
      expect(
        known.has(f.topic),
        `forward-map 的 topic "${f.topic}" 不是 Topics 的真值（手抄字符串会漂移）`,
      ).toBe(true);
    }
  });

  it('EVENT_FORWARD_MAP 的每个 event 都在 ALLOWED_EVENTS 白名单内', () => {
    for (const f of EVENT_FORWARD_MAP) {
      expect(
        ALLOWED_EVENT_SET.has(f.event),
        `forward-map 的事件 "${f.event}" 不在 IPC 白名单内（会被 IpcBridge 丢弃）`,
      ).toBe(true);
    }
  });

  it('EVENT_FORWARD_MAP 覆盖 ALLOWED_EVENTS 的全部事件（无遗漏）', () => {
    const mapped = new Set(EVENT_FORWARD_MAP.map((f) => f.event));
    const missing = ALLOWED_EVENTS.filter((e) => !mapped.has(e));
    expect(
      missing,
      `白名单事件无转发表条目，renderer 永远收不到：${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('EVENT_FORWARD_MAP 无重复 topic 与重复 event', () => {
    const topics = EVENT_FORWARD_MAP.map((f) => f.topic);
    const events = EVENT_FORWARD_MAP.map((f) => f.event);
    expect(new Set(topics).size).toBe(topics.length);
    expect(new Set(events).size).toBe(events.length);
  });
});
