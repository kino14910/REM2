/**
 * 插件模块解析：entry **只指向构建产物**（`.js` / `.mjs`）。
 *
 * 零依赖：仅 node:url / node:path / node:fs。
 *
 * 补全列表已删除 `.ts` 与 `index.ts`（docs/10 §5.1 / docs/13 §1.2 #55）：
 * 允许 `.ts` 入口就是「主进程需要注册 tsx loader」的根因，而那条通道已被 forge Fuses 封死。
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
 * - 形如 `dist/index.js` 的「路径式」 entry（含 `/` 或已知扩展名）→ 同样按相对路径处理。
 * - 其余裸包名 → 原样返回（交由 Node 解析）。
 * - 无扩展名时按 [.js, .mjs, .cjs, index.js, index.mjs] 顺序补全（**不含 .ts**）。
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

  // 补全扩展名：只认构建产物。
  const candidates = [
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
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
 * 判断 entry 是否为「路径式」说明符。
 *
 * 路径式：含路径分隔符（`/` 或 `\`），或以已知脚本扩展名结尾。
 * 反例：`lodash` / `@scope/pkg`（纯包名，按 Node 包解析）。
 *
 * 仍保留 `.ts` 判定：这不是「允许 TS 入口」，而是让 `dist/index.ts` 这类
 * 非法 entry 走路径解析从而在 manifest 校验阶段就被拒（而非被当成裸包名）。
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
