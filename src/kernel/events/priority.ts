/**
 * 事件优先级规则（docs/02 §G.3）。
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
