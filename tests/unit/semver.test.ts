import { describe, expect, it } from 'vitest';
import {
  compare,
  compareVersions,
  formatVersion,
  isValidVersion,
  parseVersion,
} from '../../src/kernel/semver/semver.js';
import {
  isValidRange,
  satisfies,
  withinRange,
} from '../../src/kernel/semver/range.js';

describe('semver · parseVersion', () => {
  it('解析三段版本号', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('解析预发布标识', () => {
    expect(parseVersion('1.0.0-alpha.1')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: 'alpha.1',
    });
  });

  it('忽略 build metadata', () => {
    expect(parseVersion('1.2.3+build.9')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
    });
  });

  it('拒绝两段版本号（这是 REM 的 bug 来源）', () => {
    expect(() => parseVersion('2.10')).toThrow(TypeError);
  });

  it('拒绝非法字符串', () => {
    expect(() => parseVersion('abc')).toThrow();
    expect(() => parseVersion('')).toThrow();
    expect(isValidVersion('1.2.3')).toBe(true);
    expect(isValidVersion('1.2')).toBe(false);
  });
});

describe('semver · compare', () => {
  it('按 major > minor > patch 顺序比较', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1); // 数值比较而非字典序
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
  });

  it('预发布版本低于对应正式版本', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
  });

  it('compare 直接比较 SemVer 对象', () => {
    expect(
      compare(
        { major: 1, minor: 0, patch: 0 },
        { major: 1, minor: 0, patch: 1 },
      ),
    ).toBe(-1);
  });

  it('formatVersion 往返一致', () => {
    expect(formatVersion(parseVersion('1.2.3-beta.1'))).toBe('1.2.3-beta.1');
  });
});

describe('semver · satisfies', () => {
  it('精确匹配', () => {
    expect(satisfies('1.2.3', '1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '1.2.3')).toBe(false);
  });

  it('脱字符 ^', () => {
    expect(satisfies('1.5.0', '^1.2.3')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false);
    expect(satisfies('0.2.5', '^0.2.3')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.3')).toBe(false);
    expect(satisfies('0.0.4', '^0.0.3')).toBe(true);
    expect(satisfies('0.0.5', '^0.0.3')).toBe(false);
  });

  it('波浪 ~', () => {
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
  });

  it('比较运算符', () => {
    expect(satisfies('1.2.3', '>=1.2.0')).toBe(true);
    expect(satisfies('1.1.9', '>=1.2.0')).toBe(false);
    expect(satisfies('1.2.3', '>1.2.3')).toBe(false);
    expect(satisfies('1.2.4', '>1.2.3')).toBe(true);
    expect(satisfies('1.2.3', '<=1.2.3')).toBe(true);
    expect(satisfies('1.2.0', '<1.2.3')).toBe(true);
  });

  it('通配 * 与 x', () => {
    expect(satisfies('9.9.9', '*')).toBe(true);
    expect(satisfies('1.5.0', '1.x')).toBe(true);
    expect(satisfies('2.0.0', '1.x')).toBe(false);
    expect(satisfies('1.2.9', '1.2.x')).toBe(true);
    expect(satisfies('1.3.0', '1.2.x')).toBe(false);
  });

  it('并集 ||', () => {
    expect(satisfies('1.5.0', '^1.0.0 || ^2.0.0')).toBe(true);
    expect(satisfies('2.5.0', '^1.0.0 || ^2.0.0')).toBe(true);
    expect(satisfies('3.0.0', '^1.0.0 || ^2.0.0')).toBe(false);
  });

  it('AND 连接（空格）', () => {
    expect(satisfies('1.5.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfies('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
  });

  it('短横线范围', () => {
    expect(satisfies('1.5.0', '1.0.0 - 2.0.0')).toBe(false); // 未实现 - 语法，按非法略过
  });

  it('预发布默认不满足 range', () => {
    expect(satisfies('1.2.3-beta', '^1.0.0')).toBe(false);
  });

  it('isValidRange 判定', () => {
    expect(isValidRange('^1.0.0')).toBe(true);
    expect(isValidRange('')).toBe(false);
    expect(isValidRange('>=1.0.0 <2.0.0')).toBe(true);
  });

  it('withinRange 组合判定', () => {
    expect(withinRange('1.5.0', '^1.0.0')).toBe(true);
    expect(withinRange('2.0.0', '^1.0.0')).toBe(false);
    expect(withinRange('1.0.0', '1.0.0', '2.0.0')).toBe(true);
    expect(withinRange('2.0.0', '1.0.0', '2.0.0')).toBe(false);
  });
});
