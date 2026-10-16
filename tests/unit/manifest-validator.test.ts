/**
 * Manifest 校验器单测（手写零依赖校验器，docs/01）。
 */

import { describe, expect, it } from 'vitest';
import { validateManifest } from '../../src/kernel/discovery/manifest-validator.js';

const valid = {
  id: 'com.rem2.demo',
  name: 'Demo',
  version: '1.0.0',
  entry: 'dist/index.js',
  compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
};

describe('manifest-validator · 合法输入', () => {
  it('最小合法 manifest 通过', () => {
    const r = validateManifest(valid);
    expect(r.ok).toBe(true);
    expect(r.value?.id).toBe('com.rem2.demo');
  });

  it('完整字段通过', () => {
    const r = validateManifest({
      ...valid,
      dependencies: { 'com.rem2.other': '^1.0.0' },
      optionalDependencies: { 'com.rem2.opt': '~1.2.0' },
      requires: ['log.sink', 'config.provide'],
      author: 'team',
      description: 'demo',
      tags: ['a', 'b'],
    });
    expect(r.ok).toBe(true);
    expect(r.value?.requires).toContain('log.sink');
  });
});

describe('manifest-validator · 非法输入', () => {
  it('非对象被拒', () => {
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest('x').ok).toBe(false);
    expect(validateManifest([]).ok).toBe(false);
  });

  it('缺失必填字段被拒', () => {
    const r = validateManifest({ name: 'x' });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === '$.id')).toBe(true);
  });

  it('id 格式非法被拒', () => {
    const r = validateManifest({ ...valid, id: 'Bad ID!' });
    expect(r.ok).toBe(false);
  });

  it('version 非 semver 被拒', () => {
    const r = validateManifest({ ...valid, version: '1.0' });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === '$.version')).toBe(true);
  });

  it('compatibility 缺失被拒', () => {
    const r = validateManifest({ ...valid, compatibility: undefined });
    expect(r.ok).toBe(false);
  });

  it('requires 非法能力名被拒', () => {
    const r = validateManifest({ ...valid, requires: ['Invalid CAP'] });
    expect(r.ok).toBe(false);
  });

  it('requires 重复被拒', () => {
    const r = validateManifest({
      ...valid,
      requires: ['log.sink', 'log.sink'],
    });
    expect(r.ok).toBe(false);
  });

  it('依赖 range 非法被拒', () => {
    const r = validateManifest({ ...valid, dependencies: { other: '' } });
    expect(r.ok).toBe(false);
  });

  it('未知字段被忽略（宽松）', () => {
    const r = validateManifest({ ...valid, unknownField: 123 });
    expect(r.ok).toBe(true);
  });
});
