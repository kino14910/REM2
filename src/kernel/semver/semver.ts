/**
 * 内核自实现的 semver 解析/比较（动机 #3：替代 REM 有 bug 的 `ver.split('.')`）。
 *
 * 支持：`major.minor.patch` + 可选预发布标识（`-alpha.1`）。
 * 本模块零依赖、纯函数、可单测。
 */

/** 解析后的版本号。 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** 预发布标识（不含前导 '-'）；无则为 undefined。 */
  prerelease?: string;
}

const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * 解析版本字符串。非法时抛 `TypeError`。
 *
 * 注意：刻意**不**接受 `2.10` 这类两位段——必须是三段 `major.minor.patch`，
 * 以避免 REM 的 `2.10` vs `2.9` 判定错误（docs/01 正确性对照）。
 */
export function parseVersion(v: string): SemVer {
  if (typeof v !== 'string') {
    throw new TypeError(`版本号必须是字符串，收到：${typeof v}`);
  }
  const trimmed = v.trim();
  const m = VERSION_RE.exec(trimmed);
  if (!m) {
    throw new TypeError(`非法版本号：${v}`);
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const prerelease = m[4];
  const result: SemVer = { major, minor, patch };
  if (prerelease !== undefined) {
    result.prerelease = prerelease;
  }
  return result;
}

/** 是否为合法版本字符串。 */
export function isValidVersion(v: string): boolean {
  try {
    parseVersion(v);
    return true;
  } catch {
    return false;
  }
}

/** 比较预发布标识：符合 semver 规则（数字段按数值比较，字母按字典序）。 */
function comparePrerelease(a?: string, b?: string): -1 | 0 | 1 {
  // 无预发布 ＞ 有预发布。
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (a === b) return 0;

  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const xa = pa[i];
    const xb = pb[i];
    if (xa === undefined) return -1;
    if (xb === undefined) return 1;
    const na = /^\d+$/.test(xa);
    const nb = /^\d+$/.test(xb);
    if (na && nb) {
      const da = Number(xa);
      const db = Number(xb);
      if (da !== db) return da < db ? -1 : 1;
    } else if (na && !nb) {
      // 数字标识优先级低于字母标识。
      return -1;
    } else if (!na && nb) {
      return 1;
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 比较两个版本。
 * @returns -1 表示 a<b，0 表示相等，1 表示 a>b。
 */
export function compare(a: SemVer, b: SemVer): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** 比较两个版本字符串。 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  return compare(parseVersion(a), parseVersion(b));
}

/** a 是否等于 b。 */
export function eq(a: SemVer, b: SemVer): boolean {
  return compare(a, b) === 0;
}

/** a 是否小于 b。 */
export function lt(a: SemVer, b: SemVer): boolean {
  return compare(a, b) === -1;
}

/** a 是否大于 b。 */
export function gt(a: SemVer, b: SemVer): boolean {
  return compare(a, b) === 1;
}

/** a 是否小于等于 b。 */
export function lte(a: SemVer, b: SemVer): boolean {
  return compare(a, b) <= 0;
}

/** a 是否大于等于 b。 */
export function gte(a: SemVer, b: SemVer): boolean {
  return compare(a, b) >= 0;
}

/** 格式化回字符串。 */
export function formatVersion(v: SemVer): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease !== undefined ? `${base}-${v.prerelease}` : base;
}

/** 是否含预发布标识。 */
export function isPrerelease(v: SemVer): boolean {
  return v.prerelease !== undefined;
}
