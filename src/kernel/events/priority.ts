export const Priority = {
  Lowest: -100,
  Low: -10,
  Normal: 0,
  High: 10,
  Highest: 100,
} as const

export interface ComparableHandler {
  priority: number
  seq: number
}

export function compareHandlers(
  a: ComparableHandler,
  b: ComparableHandler,
): number {
  if (a.priority !== b.priority) return b.priority - a.priority
  return a.seq - b.seq
}

export function normalizePriority(p?: number): number {
  return typeof p === 'number' && Number.isFinite(p) ? p : Priority.Normal
}

/**
 * Binary-insert `item` into an already sorted array at the correct
 * position by "priority descending, then seq ascending".
 *
 * Why insert at subscription time instead of sorting at emit time: the
 * bucket index narrows candidates to same-first-segment buckets whose
 * elements are naturally ordered, so emit only walks two buckets in
 * order instead of filtering and sorting the whole table every time.
 */
export function insertOrdered<T extends ComparableHandler>(
  sorted: T[],
  item: T,
): void {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    // compareHandlers(mid, item) <= 0 -> item belongs after mid
    if (compareHandlers(sorted[mid]!, item) <= 0) lo = mid + 1
    else hi = mid
  }
  sorted.splice(lo, 0, item)
}
