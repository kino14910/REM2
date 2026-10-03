/**
 * 插件模块解析（docs/02 §A.8：entry 支持 .ts / .js / .cjs / 包名）。
 *
 * 零依赖：仅 node:url / node:path / node:fs。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EntryEscapeError } from '../errors.js';

/** 解析结果。 */
export interface ResolvedEntry {
  /** 可传给 `import()` 的说明符（file URL 或包名）。 */
  specifier: string;
  /** 解析出的绝对路径（包名场景为 undefined）。 */
  filePath?: string;
}

/**
 * 把 manifest.entry 解析为可动态 import 的说明符。
 *
 * - 绝对路径 / 相对路径（以 ./ ../ 开头）→ 相对插件 rootDir 解析为 file URL。
 * - 形如 `src/index.ts` 的"路径式" entry（含 `/` 或已知扩展名）→ 同样按相对路径处理
 *   （裸包名不允许含 `/` 之外的路径分隔形态，且入口不可能是裸包名带扩展名）。
 * - 其余裸包名 → 原样返回（交由 Node 解析）。
 * - 无扩展名时按 [.ts, .js, .mjs, .cjs, index.ts, index.js] 顺序补全。
 *
 * 安全边界（E_ENTRY_ESCAPE）：路径式入口解析后**必须仍位于 rootDir 内**；
 * 绝对路径也必须指向 rootDir 内部。否则插件可借 manifest 让内核 import 任意磁盘文件。
 */
export function resolveEntry(
  rootDir: string,
  entry: string,
  pluginId = entry,
): ResolvedEntry {
  const isRelative = entry.startsWith('./') || entry.startsWith('../');
  const isAbsolute = path.isAbsolute(entry);
  const isFileUrl = entry.startsWith('file:');
  const looksLikePath = looksLikeFilePath(entry);

  if (!isRelative && !isAbsolute && !isFileUrl && !looksLikePath) {
    // 裸包名
    return { specifier: entry };
  }

  const root = path.resolve(rootDir);
  const base = isAbsolute ? path.resolve(entry) : path.resolve(root, entry);
  assertInsideRoot(root, base, pluginId, entry);

  if (existsSync(base)) {
    return toFileUrl(base);
  }

  // 补全扩展名
  const candidates = [
    `${base}.ts`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.js'),
    path.join(base, 'index.mjs'),
    path.join(base, 'index.cjs'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      return toFileUrl(c);
    }
  }

  // 找不到时仍返回原路径（让 import 抛出可诊断的模块解析错误）。
  return toFileUrl(base);
}

/** 断言解析结果位于插件根目录内（含边界）。 */
function assertInsideRoot(
  root: string,
  target: string,
  pluginId: string,
  entry: string,
): void {
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new EntryEscapeError(pluginId, entry);
  }
}

/**
 * 判断 entry 是否为"路径式"说明符。
 *
 * 路径式：含路径分隔符（`/` 或 `\`），或以已知脚本扩展名结尾。
 * 反例：`lodash` / `@scope/pkg`（纯包名，按 Node 包解析）。
 */
function looksLikeFilePath(entry: string): boolean {
  if (entry.includes('/') || entry.includes('\\')) return true;
  return /\.(ts|mts|cts|js|mjs|cjs|tsx|jsx)$/i.test(entry);
}

function toFileUrl(filePath: string): ResolvedEntry {
  return { specifier: pathToFileURL(filePath).href, filePath };
}

/** 插件根目录的规范化（去尾分隔符）。 */
export function normalizeRoot(rootDir: string): string {
  return path.resolve(rootDir);
}
