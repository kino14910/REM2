/**
 * 边界单测 · semver（docs/01）。
 *
 * 重点证明 REM 的已知 bug（`ver.split('.')` 导致 `2.10` < `2.9`）在 rem2 中已修复：
 * 版本比较按「数值」而非「字典序」。
 */

import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  parseVersion,
} from '../../src/kernel/semver/semver.js';
import { isValidRange, satisfies } from '../../src/kernel/semver/range.js';

describe('semver-boundary · REM 已知 bug 回归', () => {
  it('2.10.0 > 2.9.0（数值比较，而非字典序）', () => {
    expect(compareVersions('2.10.0', '2.9.0')).toBe(1);
    expect(compareVersions('2.9.0', '2.10.0')).toBe(-1);
  });

  it('1.10.0 > 1.9.0，1.2.10 > 1.2.9', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1);
  });

  it('两段版本 2.10 被拒绝（REM bug 的根因）', () => {
    expect(() => parseVersion('2.10')).toThrow(TypeError);
  });

  it('range 判定同样采用数值比较：^2.9.0 接受 2.10.0', () => {
    expect(satisfies('2.10.0', '^2.9.0')).toBe(true);
    expect(satisfies('2.9.0', '^2.10.0')).toBe(false);
  });
});

describe('semver-boundary · 预发布语义', () => {
  it('预发布 < 对应正式版本', () => {
    expect(compareVersions('2.0.0-alpha', '2.0.0')).toBe(-1);
    expect(compareVersions('2.0.0', '2.0.0-alpha')).toBe(1);
  });

  it('数字标识优先级低于字母标识（semver 规则）', () => {
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-1')).toBe(1);
  });

  it('数字标识按数值比较：alpha.10 > alpha.9', () => {
    expect(compareVersions('1.0.0-alpha.10', '1.0.0-alpha.9')).toBe(1);
  });

  it('段数少者优先：alpha < alpha.1', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
  });

  it('预发布默认不满足 range，除非 range 显式含同核心预发布', () => {
    expect(satisfies('2.0.0-beta.1', '^2.0.0')).toBe(false);
    expect(satisfies('2.0.0-beta.1', '>=2.0.0-beta.0 <2.0.0')).toBe(true);
  });
});

describe('semver-boundary · range 边界', () => {
  it('caret 上界不含：2.0.0 不满足 ^1.9.0', () => {
    expect(satisfies('2.0.0', '^1.9.0')).toBe(false);
    expect(satisfies('1.99.99', '^1.9.0')).toBe(true);
  });

  it('tilde 仅锁 minor：~1.2.0 不含 1.3.0', () => {
    expect(satisfies('1.2.99', '~1.2.0')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.0')).toBe(false);
  });

  it('精确匹配不做前缀匹配', () => {
    expect(satisfies('1.2.3', '1.2.3')).toBe(true);
    expect(satisfies('1.2.30', '1.2.3')).toBe(false);
  });

  it('未实现的 `-` 语法被判定为非法 range 且不满足（不抛错）', () => {
    expect(isValidRange('1.0.0 - 2.0.0')).toBe(false);
    expect(satisfies('1.5.0', '1.0.0 - 2.0.0')).toBe(false);
  });
});
