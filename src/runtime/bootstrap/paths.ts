/**
 * 运行时路径解析（CLI 引导 + Electron 外壳共用）。
 *
 * 零依赖：node:fs / node:path / node:url / node:process。
 *
 * 必须同时兼容三种运行形态：
 * 1. **ESM**（`tsx` / 原生 ESM）：`import.meta.url` 可用。
 * 2. **CJS bundle**（Electron 主进程，Vite/Rollup 产物 `.vite/build/main.cjs`）：
 *    `import.meta.url` 被编译为 `undefined`，此时改用 `__dirname`。
 * 3. **兜底**：`process.cwd()`。
 *
 * 历史缺陷：早期实现把 `fileURLToPath(import.meta.url)` 写成默认参数，
 * 在 Electron 主进程里 `import.meta.url === undefined` →
 * `fileURLToPath(undefined)` 抛 `ERR_INVALID_ARG_TYPE`，外壳启动即崩。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** CJS 环境下的模块目录（ESM 中为 undefined）。 */
declare const __dirname: string | undefined;

/**
 * 当前模块所在目录（兼容 ESM / CJS）。
 *
 * 每一步都必须**判空后再用**，绝不允许把 `undefined` 传给 `fileURLToPath`。
 */
function moduleDir(): string | undefined {
  // 1) CJS bundle：Electron 主进程走这条。
  //    `typeof` 判空在 ESM 下同样安全（返回 'undefined' 而非抛错）。
  if (typeof __dirname === 'string' && __dirname.length > 0) {
    return __dirname;
  }

  // 2) ESM：`import.meta.url`；在 CJS 产物中被编译为 undefined。
  const metaUrl = (import.meta as { url?: string }).url;
  if (typeof metaUrl === 'string' && metaUrl.length > 0) {
    try {
      return path.dirname(fileURLToPath(metaUrl));
    } catch {
      // 非法 URL → 落到下一策略。
    }
  }

  return undefined;
}

/** 从 `start` 向上回溯，找到第一个含 package.json 的目录。 */
function findUp(start: string): string | undefined {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * 项目根目录（含 package.json 的目录）。
 *
 * @param fromFile 可选：显式锚点文件；缺省时按「模块目录 → cwd」依次向上回溯。
 */
export function projectRoot(fromFile?: string): string {
  const anchors: string[] = [];
  if (fromFile) anchors.push(path.dirname(fromFile));

  const dir = moduleDir();
  if (dir) anchors.push(dir);

  anchors.push(process.cwd());

  for (const anchor of anchors) {
    const found = findUp(anchor);
    if (found) return found;
  }
  return process.cwd();
}

/** 内建插件目录。 */
export function builtinPluginsRoot(root = projectRoot()): string {
  return path.join(root, 'plugins');
}

/** 示例配置目录。 */
export function examplesDir(root = projectRoot()): string {
  return path.join(root, 'examples');
}
