/**
 * Deep merge (used for config layering).
 *
 * Rules:
 * - Plain objects merge recursively; later layers override earlier ones.
 * - Arrays, primitives, and null are replaced wholesale (no element-level merge,
 *   to avoid ambiguous config semantics).
 * - Inputs are never mutated (a new object is returned).
 */

/** Checks whether a value is a plain object (excludes arrays, null, Date, etc.). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): T {
  const result: Record<string, unknown> = { ...base }

  for (const [key, value] of Object.entries(override)) {
    const existing = result[key]
    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMerge(existing, value)
    } else if (value !== undefined) {
      result[key] = value
    }
  }

  return result as T
}

export function deepMergeAll(
  layers: Array<Record<string, unknown>>,
): Record<string, unknown> {
  let acc: Record<string, unknown> = {}
  for (const layer of layers) {
    acc = deepMerge(acc, layer ?? {})
  }
  return acc
}

/** Reads a value by dotted path ('a.b.c'); undefined means the path does not exist. */
export function getPath(obj: unknown, path: string): unknown {
  if (path === '') return obj
  const segments = path.split('.')
  let cur: unknown = obj
  for (const seg of segments) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined
    }
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** Deep clone (handles only JSON-expressible structures plus plain objects/arrays). */
export function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(v => deepClone(v)) as unknown as T
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepClone(v)
    }
    return out as unknown as T
  }
  return value
}
