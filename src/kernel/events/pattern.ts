/**
 * 事件模式匹配（通配符分派，见 docs/01）。
 *
 * 语义（同时支持 `:` 与 `.` 作为段分隔符）：
 * - `a:b:c`、`a.b.c` 精确匹配
 * - `a:*`、`a.*` 匹配 `a` 下任意「单段」
 * - `a:**`、`a.**`、`kernel.**` 递归匹配 `a` 及其所有后代（含 `a` 本身，但需至少一段）
 * - `*` 匹配任何单段；`**` 匹配一切
 *
 * 说明：`*` 单段不跨越分隔符（`command:*` 不匹配 `command:execute:sub`）。
 * `**` 递归匹配（`command:**` 匹配 `command:execute:sub`，`kernel.**` 匹配 `kernel.plugin.started`）。
 */

/** 判断字符是否为分隔符。 */
function isSeparator(ch: string): boolean {
  return ch === ':' || ch === '.';
}

/** 把名称按 ':' / '.' 切成段（连续分隔符合并为一个）。 */
export function splitSegments(name: string): string[] {
  const parts: string[] = [];
  let cur = '';
  for (const ch of name) {
    if (isSeparator(ch)) {
      if (cur.length > 0) {
        parts.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) parts.push(cur);
  return parts;
}

/**
 * 判断模式是否匹配某事件名。
 *
 * @param pattern 订阅模式
 * @param event   实际事件名
 */
export function matches(pattern: string, event: string): boolean {
  if (pattern === event) return true;
  if (pattern === '**') return true;
  if (pattern === '*') {
    // 全局 * 匹配一切（含多段）。
    return true;
  }

  const pSegs = splitSegments(pattern);
  const eSegs = splitSegments(event);
  return matchSegments(pSegs, 0, eSegs, 0);
}

function matchSegments(
  p: string[],
  pi: number,
  e: string[],
  ei: number,
): boolean {
  if (pi === p.length) {
    return ei === e.length;
  }

  const seg = p[pi]!;

  if (seg === '**') {
    // ** 吞掉一个或多个剩余段；若 ** 是最后一段，则匹配剩余任意（含 1 段及以上）。
    if (pi === p.length - 1) {
      return ei < e.length;
    }
    for (let k = ei; k <= e.length; k += 1) {
      if (matchSegments(p, pi + 1, e, k)) return true;
    }
    return false;
  }

  if (ei === e.length) return false;

  if (seg === '*') {
    return matchSegments(p, pi + 1, e, ei + 1);
  }

  if (seg !== e[ei]) return false;
  return matchSegments(p, pi + 1, e, ei + 1);
}

/**
 * 取模式的首段，作为分桶键。
 *
 * 桶索引的前提（docs/06 O16）：`a:b:c` 模式**只可能**匹配首段为 `a` 的事件；
 * `*` / `**` 模式匹配任意首段，必须进「通配桶」。
 */
export function bucketKeyOf(pattern: string): string {
  const segs = splitSegments(pattern);
  const first = segs[0];
  if (first === undefined || first === '*' || first === '**') return WILDCARD_BUCKET;
  return first;
}

/** 通配桶键（`*` / `**` 模式专用）。 */
export const WILDCARD_BUCKET = '*';

/** 事件名所属的桶键。 */
export function bucketKeyOfEvent(event: string): string {
  return splitSegments(event)[0] ?? WILDCARD_BUCKET;
}

/** 模式"特异性"打分（用于优先级相等时的确定性排序，越大越具体）。 */
export function specificity(pattern: string): number {
  if (pattern === '**') return 0;
  const segs = splitSegments(pattern);
  let score = 0;
  for (const s of segs) {
    if (s === '**') score += 0;
    else if (s === '*') score += 1;
    else score += 10;
  }
  return score;
}
