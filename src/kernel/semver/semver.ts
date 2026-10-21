/**
 * Kernel-internal semver parsing/comparison, reimplemented to replace REM's
 * buggy `ver.split('.')` comparison.
 */

export interface SemVer {
  major: number
  minor: number
  patch: number
  /** Prerelease identifier without the leading '-'; undefined when absent. */
  prerelease?: string
}

const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Parse a version string. Throws `TypeError` on invalid input.
 *
 * Deliberately rejects two-segment versions like `2.10`: only three-segment
 * `major.minor.patch` is accepted, to avoid REM's `2.10` vs `2.9` bug.
 */
export function parseVersion(v: string): SemVer {
  if (typeof v !== 'string') {
    throw new TypeError(`version must be a string, received: ${typeof v}`)
  }
  const trimmed = v.trim()
  const m = VERSION_RE.exec(trimmed)
  if (!m) {
    throw new TypeError(`invalid version: ${v}`)
  }
  const major = Number(m[1])
  const minor = Number(m[2])
  const patch = Number(m[3])
  const prerelease = m[4]
  const result: SemVer = { major, minor, patch }
  if (prerelease !== undefined) {
    result.prerelease = prerelease
  }
  return result
}

export function isValidVersion(v: string): boolean {
  try {
    parseVersion(v)
    return true
  } catch {
    return false
  }
}

/** Compare prerelease identifiers per semver rules: numeric segments compare numerically, alphanumeric segments lexically. */
function comparePrerelease(a?: string, b?: string): -1 | 0 | 1 {
  // A release outranks its prereleases.
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  if (a === b) return 0

  const pa = a.split('.')
  const pb = b.split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const xa = pa[i]
    const xb = pb[i]
    if (xa === undefined) return -1
    if (xb === undefined) return 1
    const na = /^\d+$/.test(xa)
    const nb = /^\d+$/.test(xb)
    if (na && nb) {
      const da = Number(xa)
      const db = Number(xb)
      if (da !== db) return da < db ? -1 : 1
    } else if (na && !nb) {
      // Numeric identifiers rank below alphanumeric ones.
      return -1
    } else if (!na && nb) {
      return 1
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1
    }
  }
  return 0
}

/**
 * Compare two versions.
 * @returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compare(a: SemVer, b: SemVer): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return comparePrerelease(a.prerelease, b.prerelease)
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  return compare(parseVersion(a), parseVersion(b))
}

export function eq(a: SemVer, b: SemVer): boolean {
  return compare(a, b) === 0
}

export function lt(a: SemVer, b: SemVer): boolean {
  return compare(a, b) === -1
}

export function gt(a: SemVer, b: SemVer): boolean {
  return compare(a, b) === 1
}

export function lte(a: SemVer, b: SemVer): boolean {
  return compare(a, b) <= 0
}

export function gte(a: SemVer, b: SemVer): boolean {
  return compare(a, b) >= 0
}

export function formatVersion(v: SemVer): string {
  const base = `${v.major}.${v.minor}.${v.patch}`
  return v.prerelease !== undefined ? `${base}-${v.prerelease}` : base
}

export function isPrerelease(v: SemVer): boolean {
  return v.prerelease !== undefined
}
