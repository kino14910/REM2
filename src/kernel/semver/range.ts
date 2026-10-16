/**
 * semver-like range 解析与判定（独立实现，动机 #3）。
 *
 * 支持语法（见 docs/01）：
 * - 精确：`1.2.3`
 * - 比较：`>1.2.3` `>=1.2.3` `<2.0.0` `<=2.0.0`
 * - 脱字符：`^1.2.3` → `>=1.2.3 <2.0.0`；`^0.x.y` 特化为 `>=0.x.y <0.(x+1).0`
 * - 波浪：`~1.2.3` → `>=1.2.3 <1.3.0`
 * - 通配：`1.x` `1.2.x` `*`
 * - 并集：`^1.0.0 || ^2.0.0`（任一满足即满足）
 * - 连接词：`>=1.0.0 <2.0.0`（空格分隔，全部满足才满足 = AND）
 * - 预发布：默认不满足 range，除非 range 显式含预发布标识
 */

import { parseVersion, compare, type SemVer, gte, lt } from './semver.js';

/** 单个比较子句。 */
interface Comparator {
  op: '>' | '>=' | '<' | '<=' | '=';
  version: SemVer;
  /** 该子句是否显式携带预发布标识。 */
  hasPrerelease: boolean;
}

/** 一组 AND 连接的比较子句。 */
type ComparatorSet = Comparator[];

/**
 * 展开一个「因子」为一个或多个比较子句。
 * 返回 null 表示该因子非法。
 */
function expandFactor(factor: string): Comparator[] | null {
  const f = factor.trim();
  if (f === '' || f === '*' || f === 'x' || f === 'X') {
    return []; // 任意版本，无约束
  }

  // 脱字符 / 波浪：作用于 partial 版本
  if (f.startsWith('^')) return expandCaret(f.slice(1));
  if (f.startsWith('~')) return expandTilde(f.slice(1));

  // 通配 partial：1.x / 1.2.x
  if (/^[0-9xX]+(\.[0-9xX]+)*$/.test(f) && /[xX]/.test(f)) {
    return expandWildcard(f);
  }

  // 比较运算符
  const opMatch = /^(>=|<=|>|<|=)?(.+)$/.exec(f);
  if (!opMatch) return null;
  const op = (opMatch[1] ?? '=') as Comparator['op'];
  const versionStr = opMatch[2]!.trim();

  // 运算符后仍可能是 partial（如 >=1.2）
  if (
    /^[0-9]+(\.[0-9xX]+)*$/.test(versionStr) &&
    versionStr.split('.').length < 3
  ) {
    return expandWildcard(versionStr, op);
  }

  let v: SemVer;
  try {
    v = parseVersion(versionStr);
  } catch {
    return null;
  }
  return [{ op, version: v, hasPrerelease: v.prerelease !== undefined }];
}

/** 展开 `^` 脱字符。 */
function expandCaret(body: string): Comparator[] | null {
  const parts = body.split('.');
  const nums = parts.map((p) => (/^[0-9xX]+$/.test(p) ? p : null));
  if (nums.some((n) => n === null)) return null;

  const seg = (i: number): string | undefined => nums[i] ?? undefined;

  const majorRaw = seg(0);
  if (majorRaw === undefined || majorRaw === 'x' || majorRaw === 'X') return [];

  const major = Number(majorRaw);
  const minorRaw = seg(1);
  const patchRaw = seg(2);

  const lower: SemVer = { major, minor: 0, patch: 0 };
  if (minorRaw !== undefined && minorRaw !== 'x' && minorRaw !== 'X') {
    lower.minor = Number(minorRaw);
    lower.patch = 0;
    if (patchRaw !== undefined && patchRaw !== 'x' && patchRaw !== 'X') {
      lower.patch = Number(patchRaw);
      if (parts[2] !== undefined) {
        // 保留原字符串里的预发布标识时需再次解析
      }
    }
  }

  // 预发布处理：^1.2.3-beta.1 的 lower 保留预发布
  const raw = tryParse(body);
  const hasPrerelease = raw !== null && raw.prerelease !== undefined;
  if (raw !== null) {
    lower.major = raw.major;
    lower.minor = raw.minor;
    lower.patch = raw.patch;
    if (raw.prerelease !== undefined) lower.prerelease = raw.prerelease;
  }

  const upper: SemVer = { major: 0, minor: 0, patch: 0 };
  if (major > 0) {
    upper.major = major + 1;
  } else if (lower.minor > 0) {
    // ^0.x.y → <0.(x+1).0
    upper.major = 0;
    upper.minor = lower.minor + 1;
  } else {
    // ^0.0.y → <=0.0.(y+1)（patch 级 caret：允许到下一 patch 为止）
    upper.major = 0;
    upper.minor = 0;
    upper.patch = lower.patch + 1;
    return [
      { op: '>=', version: lower, hasPrerelease },
      { op: '<=', version: upper, hasPrerelease: false },
    ];
  }

  return [
    { op: '>=', version: lower, hasPrerelease },
    { op: '<', version: upper, hasPrerelease: false },
  ];
}

/** 展开 `~` 波浪。 */
function expandTilde(body: string): Comparator[] | null {
  const raw = tryParse(body);
  const parts = body.split('.');

  let lower: SemVer;
  let minor = 0;
  if (raw !== null) {
    lower = raw;
    minor = raw.minor;
  } else if (parts.length === 1 && /^\d+$/.test(parts[0]!)) {
    lower = { major: Number(parts[0]), minor: 0, patch: 0 };
    minor = 0;
  } else {
    return null;
  }

  const upper: SemVer = { major: lower.major, minor: minor + 1, patch: 0 };
  return [
    { op: '>=', version: lower, hasPrerelease: lower.prerelease !== undefined },
    { op: '<', version: upper, hasPrerelease: false },
  ];
}

/** 展开通配 partial（`1.x` / `1.2.x`）或带运算符的 partial（`>=1.2`）。 */
function expandWildcard(
  body: string,
  op?: Comparator['op'],
): Comparator[] | null {
  const parts = body.split('.').map((p) => p.trim());
  const nums: Array<number | 'x'> = parts.map((p) => {
    if (p === 'x' || p === 'X' || p === '*' || p === '') return 'x';
    if (/^\d+$/.test(p)) return Number(p);
    return 'x';
  });

  // 计算「被固定」的段数
  const fixedCount = nums.findIndex((n) => n === 'x');
  const effectiveFixed = fixedCount === -1 ? nums.length : fixedCount;

  if (effectiveFixed === 0) return []; // 全通配

  if (op && op !== '=') {
    // `>=1.2` → >=1.2.0；`<1.2` → <1.2.0；`>1.2` → >=1.3.0（标准 semver 语义）
    const base = partialToVersion(nums, effectiveFixed);
    if (op === '>') {
      const bumped = bumpMinor(nums, effectiveFixed);
      return [{ op: '>=', version: bumped, hasPrerelease: false }];
    }
    if (op === '<=') {
      const bumped = bumpMinor(nums, effectiveFixed);
      return [{ op: '<', version: bumped, hasPrerelease: false }];
    }
    return [{ op, version: base, hasPrerelease: false }];
  }

  // 精确通配：1.x → >=1.0.0 <2.0.0；1.2.x → >=1.2.0 <1.3.0
  const lower = partialToVersion(nums, effectiveFixed);
  const upper: SemVer = { ...lower };
  if (effectiveFixed === 1) {
    upper.major = lower.major + 1;
    upper.minor = 0;
    upper.patch = 0;
  } else if (effectiveFixed === 2) {
    upper.minor = lower.minor + 1;
    upper.patch = 0;
  } else {
    upper.patch = lower.patch + 1;
  }
  return [
    { op: '>=', version: lower, hasPrerelease: false },
    { op: '<', version: upper, hasPrerelease: false },
  ];
}

/** 把固定段转成版本（其余补 0）。 */
function partialToVersion(nums: Array<number | 'x'>, fixed: number): SemVer {
  const v: SemVer = { major: 0, minor: 0, patch: 0 };
  if (fixed >= 1 && typeof nums[0] === 'number') v.major = nums[0];
  if (fixed >= 2 && typeof nums[1] === 'number') v.minor = nums[1];
  if (fixed >= 3 && typeof nums[2] === 'number') v.patch = nums[2];
  return v;
}

/** 把 partial 提升到下一个 minor（用于 `>1.2` / `<=1.2`）。 */
function bumpMinor(nums: Array<number | 'x'>, fixed: number): SemVer {
  const v = partialToVersion(nums, fixed);
  v.minor += 1;
  v.patch = 0;
  return v;
}

function tryParse(s: string): SemVer | null {
  try {
    return parseVersion(s);
  } catch {
    return null;
  }
}

/** range 编译缓存（避免每次 satisfies 重新解析）。 */
const CACHE = new Map<string, ComparatorSet[]>();
const CACHE_LIMIT = 512;

/**
 * 把一个 range 字符串编译为 ComparatorSet 列表（并集：任一 set 满足即满足）。
 * 返回 null 表示非法 range。
 */
function compile(range: string): ComparatorSet[] | null {
  const cached = CACHE.get(range);
  if (cached) return cached;

  const result: ComparatorSet[] = [];
  const alternatives = range.split('||');

  for (const alt of alternatives) {
    const tokens = alt
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    const set: ComparatorSet = [];
    for (const token of tokens) {
      // 允许 `>= 1.2.3`（运算符与版本间有空格）的写法
      const expanded = expandFactor(token);
      if (expanded === null) return null;
      for (const c of expanded) set.push(c);
    }
    // 空 set（如 `*`）代表无约束，直接返回整体无约束
    if (set.length === 0) {
      const r: ComparatorSet[] = [[]];
      remember(range, r);
      return r;
    }
    result.push(set);
  }

  if (result.length === 0) return null;
  remember(range, result);
  return result;
}

function remember(range: string, value: ComparatorSet[]): void {
  if (CACHE.size >= CACHE_LIMIT) CACHE.clear();
  CACHE.set(range, value);
}

/** 判定单个比较子句。 */
function testComparator(ver: SemVer, c: Comparator): boolean {
  const cmp = compare(ver, c.version);
  switch (c.op) {
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '=':
      return cmp === 0;
    default:
      return false;
  }
}

/**
 * 判断版本是否满足 range。
 *
 * 预发布规则：若被测版本含预发布标识，则仅当某个比较子句同样显式含预发布
 * 且同 [major,minor,patch] 时才可能满足（简化实现，符合 见 docs/01）。
 */
export function satisfies(version: string, range: string): boolean {
  if (typeof version !== 'string' || typeof range !== 'string') return false;

  let ver: SemVer;
  try {
    ver = parseVersion(version);
  } catch {
    return false;
  }

  const sets = compile(range);
  if (sets === null) {
    // 非法 range（如未实现的 `-` 语法）按"不满足"处理，而非抛错。
    return false;
  }

  return sets.some((set) => setSatisfies(ver, set));
}

function setSatisfies(ver: SemVer, set: ComparatorSet): boolean {
  if (set.length === 0) return true;

  // 预发布保护：被测版本含预发布时，必须存在一个「同核心版本且显式预发布」的子句。
  if (ver.prerelease !== undefined) {
    const allowedByPrerelease = set.some(
      (c) =>
        c.hasPrerelease &&
        c.version.major === ver.major &&
        c.version.minor === ver.minor &&
        c.version.patch === ver.patch,
    );
    if (!allowedByPrerelease) return false;
  }

  return set.every((c) => testComparator(ver, c));
}

/** 判断 range 是否合法。 */
export function isValidRange(range: string): boolean {
  if (typeof range !== 'string' || range.trim() === '') return false;
  try {
    return compile(range) !== null;
  } catch {
    return false;
  }
}

/** 便捷：`gte(version, min)` 且 `lt(version, max)`（供兼容性判定复用）。 */
export function withinRange(
  version: string,
  min: string,
  max?: string,
): boolean {
  let ver: SemVer;
  try {
    ver = parseVersion(version);
  } catch {
    return false;
  }
  if (isValidRange(min)) {
    if (!satisfies(version, min)) return false;
  } else {
    // min 可能是插件的 minKernel（range 语法），若非 range 则当作精确版本比较
    const minV = tryParse(min);
    if (minV && !gte(ver, minV)) return false;
  }
  if (max !== undefined) {
    const maxV = tryParse(max);
    if (maxV && !lt(ver, maxV)) return false;
  }
  return true;
}
