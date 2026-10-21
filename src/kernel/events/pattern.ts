/**
 * Event pattern matching (wildcard dispatch).
 *
 * Semantics (both `:` and `.` work as segment separators):
 * - `a:b:c`, `a.b.c` exact match
 * - `a:*`, `a.*` match any single segment under `a`
 * - `a:**`, `a.**`, `kernel.**` recursively match `a` and all its
 *   descendants (at least one segment required)
 * - `*` matches any single segment; `**` matches everything
 *
 * Note: a single `*` never crosses separators (`command:*` does not match
 * `command:execute:sub`), while `**` matches recursively (`command:**`
 * matches `command:execute:sub`, `kernel.**` matches `kernel.plugin.started`).
 */

function isSeparator(ch: string): boolean {
  return ch === ':' || ch === '.'
}

/** Split a name into segments on ':' / '.' (consecutive separators merge into one). */
export function splitSegments(name: string): string[] {
  const parts: string[] = []
  let cur = ''
  for (const ch of name) {
    if (isSeparator(ch)) {
      if (cur.length > 0) {
        parts.push(cur)
        cur = ''
      }
    } else {
      cur += ch
    }
  }
  if (cur.length > 0) parts.push(cur)
  return parts
}

export function matches(pattern: string, event: string): boolean {
  if (pattern === event) return true
  if (pattern === '**') return true
  if (pattern === '*') {
    // A bare `*` matches everything, including multi-segment events.
    return true
  }

  const pSegs = splitSegments(pattern)
  const eSegs = splitSegments(event)
  return matchSegments(pSegs, 0, eSegs, 0)
}

function matchSegments(
  p: string[],
  pi: number,
  e: string[],
  ei: number,
): boolean {
  if (pi === p.length) {
    return ei === e.length
  }

  const seg = p[pi]!

  if (seg === '**') {
    // ** consumes one or more remaining segments; as the last segment it matches any remainder (at least one segment).
    if (pi === p.length - 1) {
      return ei < e.length
    }
    for (let k = ei; k <= e.length; k += 1) {
      if (matchSegments(p, pi + 1, e, k)) return true
    }
    return false
  }

  if (ei === e.length) return false

  if (seg === '*') {
    return matchSegments(p, pi + 1, e, ei + 1)
  }

  if (seg !== e[ei]) return false
  return matchSegments(p, pi + 1, e, ei + 1)
}

/**
 * Take the first segment of a pattern as its bucket key.
 *
 * Bucketing relies on the invariant that an `a:b:c` pattern can only match
 * events whose first segment is `a`; `*` / `**` patterns match any first
 * segment and must go into the wildcard bucket.
 */
export function bucketKeyOf(pattern: string): string {
  const segs = splitSegments(pattern)
  const first = segs[0]
  if (first === undefined || first === '*' || first === '**')
    return WILDCARD_BUCKET
  return first
}

export const WILDCARD_BUCKET = '*'

export function bucketKeyOfEvent(event: string): string {
  return splitSegments(event)[0] ?? WILDCARD_BUCKET
}

/** Specificity score of a pattern (deterministic tie-break when priorities are equal; higher means more specific). */
export function specificity(pattern: string): number {
  if (pattern === '**') return 0
  const segs = splitSegments(pattern)
  let score = 0
  for (const s of segs) {
    if (s === '**') score += 0
    else if (s === '*') score += 1
    else score += 10
  }
  return score
}
