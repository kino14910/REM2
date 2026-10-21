import { parseVersion, compare, type SemVer, gte, lt } from './semver.js'

interface Comparator {
  op: '>' | '>=' | '<' | '<=' | '='
  version: SemVer
  /** Whether this comparator explicitly carries a prerelease identifier. */
  hasPrerelease: boolean
}

/** A group of AND-connected comparators. */
type ComparatorSet = Comparator[]

/** Expand one factor into zero or more comparators; null means the factor is invalid. */
function expandFactor(factor: string): Comparator[] | null {
  const f = factor.trim()
  if (f === '' || f === '*' || f === 'x' || f === 'X') {
    return [] // any version; no constraints
  }

  if (f.startsWith('^')) return expandCaret(f.slice(1))
  if (f.startsWith('~')) return expandTilde(f.slice(1))

  if (/^[0-9xX]+(\.[0-9xX]+)*$/.test(f) && /[xX]/.test(f)) {
    return expandWildcard(f)
  }

  const opMatch = /^(>=|<=|>|<|=)?(.+)$/.exec(f)
  if (!opMatch) return null
  const op = (opMatch[1] ?? '=') as Comparator['op']
  const versionStr = opMatch[2]!.trim()

  // a partial may still follow the operator (e.g. >=1.2)
  if (
    /^[0-9]+(\.[0-9xX]+)*$/.test(versionStr) &&
    versionStr.split('.').length < 3
  ) {
    return expandWildcard(versionStr, op)
  }

  let v: SemVer
  try {
    v = parseVersion(versionStr)
  } catch {
    return null
  }
  return [{ op, version: v, hasPrerelease: v.prerelease !== undefined }]
}

function expandCaret(body: string): Comparator[] | null {
  const parts = body.split('.')
  const nums = parts.map(p => (/^[0-9xX]+$/.test(p) ? p : null))
  if (nums.some(n => n === null)) return null

  const seg = (i: number): string | undefined => nums[i] ?? undefined

  const majorRaw = seg(0)
  if (majorRaw === undefined || majorRaw === 'x' || majorRaw === 'X') return []

  const major = Number(majorRaw)
  const minorRaw = seg(1)
  const patchRaw = seg(2)

  const lower: SemVer = { major, minor: 0, patch: 0 }
  if (minorRaw !== undefined && minorRaw !== 'x' && minorRaw !== 'X') {
    lower.minor = Number(minorRaw)
    lower.patch = 0
    if (patchRaw !== undefined && patchRaw !== 'x' && patchRaw !== 'X') {
      lower.patch = Number(patchRaw)
      if (parts[2] !== undefined) {
        // preserving the prerelease from the raw string requires a re-parse
      }
    }
  }

  // prerelease handling: the lower bound of ^1.2.3-beta.1 keeps its prerelease
  const raw = tryParse(body)
  const hasPrerelease = raw !== null && raw.prerelease !== undefined
  if (raw !== null) {
    lower.major = raw.major
    lower.minor = raw.minor
    lower.patch = raw.patch
    if (raw.prerelease !== undefined) lower.prerelease = raw.prerelease
  }

  const upper: SemVer = { major: 0, minor: 0, patch: 0 }
  if (major > 0) {
    upper.major = major + 1
  } else if (lower.minor > 0) {
    // ^0.x.y -> <0.(x+1).0
    upper.major = 0
    upper.minor = lower.minor + 1
  } else {
    // ^0.0.y -> <=0.0.(y+1) (patch-level caret: allows up to the next patch)
    upper.major = 0
    upper.minor = 0
    upper.patch = lower.patch + 1
    return [
      { op: '>=', version: lower, hasPrerelease },
      { op: '<=', version: upper, hasPrerelease: false },
    ]
  }

  return [
    { op: '>=', version: lower, hasPrerelease },
    { op: '<', version: upper, hasPrerelease: false },
  ]
}

function expandTilde(body: string): Comparator[] | null {
  const raw = tryParse(body)
  const parts = body.split('.')

  let lower: SemVer
  let minor = 0
  if (raw !== null) {
    lower = raw
    minor = raw.minor
  } else if (parts.length === 1 && /^\d+$/.test(parts[0]!)) {
    lower = { major: Number(parts[0]), minor: 0, patch: 0 }
    minor = 0
  } else {
    return null
  }

  const upper: SemVer = { major: lower.major, minor: minor + 1, patch: 0 }
  return [
    { op: '>=', version: lower, hasPrerelease: lower.prerelease !== undefined },
    { op: '<', version: upper, hasPrerelease: false },
  ]
}

function expandWildcard(
  body: string,
  op?: Comparator['op'],
): Comparator[] | null {
  const parts = body.split('.').map(p => p.trim())
  const nums: Array<number | 'x'> = parts.map(p => {
    if (p === 'x' || p === 'X' || p === '*' || p === '') return 'x'
    if (/^\d+$/.test(p)) return Number(p)
    return 'x'
  })

  const fixedCount = nums.findIndex(n => n === 'x')
  const effectiveFixed = fixedCount === -1 ? nums.length : fixedCount

  if (effectiveFixed === 0) return [] // fully wildcarded: no constraints

  if (op && op !== '=') {
    // `>=1.2` -> >=1.2.0; `<1.2` -> <1.2.0; `>1.2` -> >=1.3.0 (standard semver semantics)
    const base = partialToVersion(nums, effectiveFixed)
    if (op === '>') {
      const bumped = bumpMinor(nums, effectiveFixed)
      return [{ op: '>=', version: bumped, hasPrerelease: false }]
    }
    if (op === '<=') {
      const bumped = bumpMinor(nums, effectiveFixed)
      return [{ op: '<', version: bumped, hasPrerelease: false }]
    }
    return [{ op, version: base, hasPrerelease: false }]
  }

  // exact wildcard: 1.x -> >=1.0.0 <2.0.0; 1.2.x -> >=1.2.0 <1.3.0
  const lower = partialToVersion(nums, effectiveFixed)
  const upper: SemVer = { ...lower }
  if (effectiveFixed === 1) {
    upper.major = lower.major + 1
    upper.minor = 0
    upper.patch = 0
  } else if (effectiveFixed === 2) {
    upper.minor = lower.minor + 1
    upper.patch = 0
  } else {
    upper.patch = lower.patch + 1
  }
  return [
    { op: '>=', version: lower, hasPrerelease: false },
    { op: '<', version: upper, hasPrerelease: false },
  ]
}

function partialToVersion(nums: Array<number | 'x'>, fixed: number): SemVer {
  const v: SemVer = { major: 0, minor: 0, patch: 0 }
  if (fixed >= 1 && typeof nums[0] === 'number') v.major = nums[0]
  if (fixed >= 2 && typeof nums[1] === 'number') v.minor = nums[1]
  if (fixed >= 3 && typeof nums[2] === 'number') v.patch = nums[2]
  return v
}

function bumpMinor(nums: Array<number | 'x'>, fixed: number): SemVer {
  const v = partialToVersion(nums, fixed)
  v.minor += 1
  v.patch = 0
  return v
}

function tryParse(s: string): SemVer | null {
  try {
    return parseVersion(s)
  } catch {
    return null
  }
}

/** Cache of compiled ranges, avoiding re-parsing on every satisfies() call. */
const CACHE = new Map<string, ComparatorSet[]>()
const CACHE_LIMIT = 512

/**
 * Compile a range string into comparator sets (union: any one set satisfies).
 * Returns null for an invalid range.
 */
function compile(range: string): ComparatorSet[] | null {
  const cached = CACHE.get(range)
  if (cached) return cached

  const result: ComparatorSet[] = []
  const alternatives = range.split('||')

  for (const alt of alternatives) {
    const tokens = alt
      .trim()
      .split(/\s+/)
      .filter(t => t.length > 0)
    const set: ComparatorSet = []
    for (const token of tokens) {
      // the `>= 1.2.3` form (space between operator and version) is allowed
      const expanded = expandFactor(token)
      if (expanded === null) return null
      for (const c of expanded) set.push(c)
    }
    // an empty set (e.g. `*`) means no constraints; return unconstrained overall
    if (set.length === 0) {
      const r: ComparatorSet[] = [[]]
      remember(range, r)
      return r
    }
    result.push(set)
  }

  if (result.length === 0) return null
  remember(range, result)
  return result
}

function remember(range: string, value: ComparatorSet[]): void {
  if (CACHE.size >= CACHE_LIMIT) CACHE.clear()
  CACHE.set(range, value)
}

function testComparator(ver: SemVer, c: Comparator): boolean {
  const cmp = compare(ver, c.version)
  switch (c.op) {
    case '>':
      return cmp > 0
    case '>=':
      return cmp >= 0
    case '<':
      return cmp < 0
    case '<=':
      return cmp <= 0
    case '=':
      return cmp === 0
    default:
      return false
  }
}

/**
 * Check whether a version satisfies a range.
 *
 * Prerelease rule: a version carrying a prerelease identifier can only
 * satisfy the range if some comparator explicitly mentions a prerelease of
 * the same [major, minor, patch] (simplified implementation).
 */
export function satisfies(version: string, range: string): boolean {
  if (typeof version !== 'string' || typeof range !== 'string') return false

  let ver: SemVer
  try {
    ver = parseVersion(version)
  } catch {
    return false
  }

  const sets = compile(range)
  if (sets === null) {
    // an invalid range (e.g. the unimplemented `-` syntax) counts as unsatisfied, not an error
    return false
  }

  return sets.some(set => setSatisfies(ver, set))
}

function setSatisfies(ver: SemVer, set: ComparatorSet): boolean {
  if (set.length === 0) return true

  if (ver.prerelease !== undefined) {
    const allowedByPrerelease = set.some(
      c =>
        c.hasPrerelease &&
        c.version.major === ver.major &&
        c.version.minor === ver.minor &&
        c.version.patch === ver.patch,
    )
    if (!allowedByPrerelease) return false
  }

  return set.every(c => testComparator(ver, c))
}

export function isValidRange(range: string): boolean {
  if (typeof range !== 'string' || range.trim() === '') return false
  try {
    return compile(range) !== null
  } catch {
    return false
  }
}

export function withinRange(
  version: string,
  min: string,
  max?: string,
): boolean {
  let ver: SemVer
  try {
    ver = parseVersion(version)
  } catch {
    return false
  }
  if (isValidRange(min)) {
    if (!satisfies(version, min)) return false
  } else {
    // min may be a plugin's minKernel (range syntax); a non-range is treated as an exact version
    const minV = tryParse(min)
    if (minV && !gte(ver, minV)) return false
  }
  if (max !== undefined) {
    const maxV = tryParse(max)
    if (maxV && !lt(ver, maxV)) return false
  }
  return true
}
