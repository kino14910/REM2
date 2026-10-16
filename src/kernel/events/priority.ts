/**
 * 事件优先级规则（见 docs/01）。
 *
 * 派发顺序：priority 降序 → 订阅 seq 升序 → 保证完全确定。
 */

/** 常用优先级常量（PascalCase，见测试约定）。 */
export const Priority = {
  Lowest: -100,
  Low: -10,
  Normal: 0,
  High: 10,
  Highest: 100,
} as const;

/** 可比较的处理器形状。 */
export interface ComparableHandler {
  priority: number;
  seq: number;
}

/**
 * 处理器排序比较器：priority 降序，同优先级按 seq 升序。
 */
export function compareHandlers(
  a: ComparableHandler,
  b: ComparableHandler,
): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.seq - b.seq;
}

/** 数值归一化：undefined → Normal。 */
export function normalizePriority(p?: number): number {
  return typeof p === 'number' && Number.isFinite(p) ? p : Priority.Normal;
}

/**
 * 按「priority 降序 → seq 升序」把 `item` 插入已排序数组的正确位置。
 *
 * 为什么在**订阅期**插入而不是 emit 时排序：桶索引把候选集缩小到
 * 「同一首段」的桶后，桶内元素天然有序，emit 只需顺序遍历两个桶
 * （docs/09 O16 要消除的正是「每次 emit 全表 filter + sort」）。
 */
export function insertOrdered<T extends ComparableHandler>(
  sorted: T[],
  item: T,
): void {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // compareHandlers(mid, item) <= 0 → item 应排在 mid 之后
    if (compareHandlers(sorted[mid]!, item) <= 0) lo = mid + 1;
    else hi = mid;
  }
  sorted.splice(lo, 0, item);
}
