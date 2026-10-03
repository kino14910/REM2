/**
 * 边界单测 · manifest 校验器（docs/02 §C.2）。
 *
 * 覆盖：缺失必填字段、非法 id、非法版本、非法能力名、重复能力、非法依赖。
 */

import { describe, expect, it } from 'vitest';
import { validateManifest } from '../../src/kernel/discovery/manifest-validator.js';

const base = {
  id: 'com.qa.demo',
  name: 'Demo',
  version: '1.0.0',
  entry: 'src/index.ts',
  compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
} as const;

describe('manifest-boundary · 必填字段', () => {
  it('空对象逐一报出全部缺失字段', () => {
    const r = validateManifest({});
    expect(r.ok).toBe(false);
    const paths = r.issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        '$.id',
        '$.name',
        '$.version',
        '$.entry',
        '$.compatibility',
      ]),
    );
  });

  it('缺失 entry 被拒', () => {
    const r = validateManifest({
      id: base.id,
      name: base.name,
      version: base.version,
      compatibility: base.compatibility,
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === '$.entry')).toBe(true);
  });

  it('compatibility 缺 minKernel / contractVersion 被拒', () => {
    const r = validateManifest({ ...base, compatibility: {} });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === '$.compatibility.minKernel')).toBe(
      true,
    );
    expect(
      r.issues.some((i) => i.path === '$.compatibility.contractVersion'),
    ).toBe(true);
  });

  it('name 为空白串被拒', () => {
    expect(validateManifest({ ...base, name: '   ' }).ok).toBe(false);
  });
});

describe('manifest-boundary · id 规则', () => {
  it.each([
    ['ab'], // 长度 < 3
    ['A-B'], // 大写
    ['-bad'], // 前导连字符
    ['bad-'], // 尾随连字符
    ['has space'],
    ['bad!'],
    ['.bad'],
    ['bad_!'],
  ])('拒绝非法 id：%s', (id) => {
    expect(validateManifest({ ...base, id }).ok).toBe(false);
  });

  it('接受 reverse-DNS 与点分 id', () => {
    expect(validateManifest({ ...base, id: 'com.rem2.hello-command' }).ok).toBe(
      true,
    );
    expect(validateManifest({ ...base, id: 'abc' }).ok).toBe(true);
  });
});

describe('manifest-boundary · version 规则', () => {
  it.each([['1.0'], ['v1.0.0'], ['1.0.0.0'], ['abc'], [''], ['1.0.0-']])(
    '拒绝非法 version：%s',
    (version) => {
      expect(validateManifest({ ...base, version }).ok).toBe(false);
    },
  );

  it('接受带预发布标识的版本', () => {
    expect(validateManifest({ ...base, version: '1.0.0-beta.1' }).ok).toBe(
      true,
    );
  });

  it('maxKernel 必须是精确版本（不接受 range）', () => {
    expect(
      validateManifest({
        ...base,
        compatibility: { ...base.compatibility, maxKernel: '^2.0.0' },
      }).ok,
    ).toBe(false);
    expect(
      validateManifest({
        ...base,
        compatibility: { ...base.compatibility, maxKernel: '2.0.0' },
      }).ok,
    ).toBe(true);
  });
});

describe('manifest-boundary · capabilities 规则', () => {
  it.each([
    ['Bad Cap'],
    ['1abc'],
    ['UPPER'],
    ['has_underscore'],
    ['a..b'],
    ['-x'],
    [''],
  ])('拒绝非法能力名：%s', (cap) => {
    expect(validateManifest({ ...base, capabilities: [cap] }).ok).toBe(false);
  });

  it('重复能力被拒', () => {
    const r = validateManifest({
      ...base,
      capabilities: ['log.sink', 'log.sink'],
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.includes('重复'))).toBe(true);
  });

  it('多个不同能力通过', () => {
    expect(
      validateManifest({
        ...base,
        capabilities: ['log.sink', 'config.provider'],
      }).ok,
    ).toBe(true);
  });
});

describe('manifest-boundary · 依赖规则', () => {
  it('非法 range 被拒', () => {
    expect(
      validateManifest({
        ...base,
        dependencies: { 'com.qa.dep': 'not a range' },
      }).ok,
    ).toBe(false);
  });

  it('非法依赖 id 被拒', () => {
    expect(
      validateManifest({ ...base, dependencies: { BAD: '^1.0.0' } }).ok,
    ).toBe(false);
  });

  it('依赖 range 非字符串被拒', () => {
    expect(
      validateManifest({ ...base, dependencies: { 'com.qa.dep': 123 } }).ok,
    ).toBe(false);
  });

  it('dependencies 非对象被拒', () => {
    expect(validateManifest({ ...base, dependencies: 'nope' }).ok).toBe(false);
  });

  it('optionalDependencies 同样校验', () => {
    expect(
      validateManifest({
        ...base,
        optionalDependencies: { 'com.qa.opt': 'bogus range' },
      }).ok,
    ).toBe(false);
  });
});
