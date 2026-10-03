/**
 * id / 路径工具。
 */

import path from 'node:path';

/**
 * 从插件目录路径推导一个合理的 plugin id（用于容错场景；正常应从 manifest 读取）。
 */
export function toPluginIdFromPath(dir: string): string {
  const base = path.basename(dir);
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized.length > 0 ? sanitized : 'unnamed-plugin';
}
