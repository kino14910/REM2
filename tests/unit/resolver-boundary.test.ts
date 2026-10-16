/**
 * 边界单测 · 依赖解析（docs/01）。
 *
 * 覆盖架构承诺：
 * - 确定性拓扑排序：同一节点集、任意输入顺序 → loadOrder 逐元素一致。
 * - 硬依赖缺失/版本不符 → 依赖者被丢弃（含级联）。
 * - 软依赖缺失 → 插件不被丢弃（仅告警）。
 * - 全硬边环 → 全部不加载。
 */

import { describe, expect, it } from 'vitest';
import { DependencyResolver } from '../../src/kernel/dependency/resolver.js';
import { makeCandidate } from '../helpers/make-manifest.js';

const OPTS = { kernelVersion: '1.0.0', contractVersion: '1' } as const;

/** 确定性洗牌（LCG），用于制造不同输入顺序。 */
function shuffle<T>(input: readonly T[], seed: number): T[] {
  const arr = input.slice();
  let s = seed;
  for (let i = arr.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

describe('resolver-boundary · 确定性拓扑排序', () => {
  const base = [
    makeCandidate({ id: 'com.qa.a' }),
    makeCandidate({ id: 'com.qa.b', dependencies: { 'com.qa.a': '^1.0.0' } }),
    makeCandidate({ id: 'com.qa.c', dependencies: { 'com.qa.b': '^1.0.0' } }),
    makeCandidate({ id: 'com.qa.d' }),
    makeCandidate({ id: 'com.qa.e', dependencies: { 'com.qa.d': '^1.0.0' } }),
    makeCandidate({ id: 'com.qa.f' }),
  ];

  it('任意输入顺序下 loadOrder 完全一致', () => {
    const resolver = new DependencyResolver();
    const expected = resolver.resolve(base, OPTS).loadOrder;

    for (let seed = 1; seed <= 40; seed += 1) {
      const plan = resolver.resolve(shuffle(base, seed), OPTS);
      expect(plan.loadOrder).toEqual(expected);
    }
  });

  it('硬依赖先于依赖者', () => {
    const resolver = new DependencyResolver();
    const order = resolver.resolve(base, OPTS).loadOrder;
    expect(order.indexOf('com.qa.a')).toBeLessThan(order.indexOf('com.qa.b'));
    expect(order.indexOf('com.qa.b')).toBeLessThan(order.indexOf('com.qa.c'));
    expect(order.indexOf('com.qa.d')).toBeLessThan(order.indexOf('com.qa.e'));
  });

  it('无依赖插件按 id 字典序确定加载', () => {
    const resolver = new DependencyResolver();
    const plan = resolver.resolve(
      [
        makeCandidate({ id: 'com.qa.z' }),
        makeCandidate({ id: 'com.qa.m' }),
        makeCandidate({ id: 'com.qa.a' }),
      ],
      OPTS,
    );
    expect(plan.loadOrder).toEqual(['com.qa.a', 'com.qa.m', 'com.qa.z']);
  });
});

describe('resolver-boundary · 硬依赖失败', () => {
  it('硬依赖缺失 → 依赖者被丢弃并报 E_MISSING_DEPENDENCY', () => {
    const resolver = new DependencyResolver();
    const plan = resolver.resolve(
      [
        makeCandidate({ id: 'com.qa.solo' }),
        makeCandidate({
          id: 'com.qa.needs',
          dependencies: { 'com.qa.absent': '^1.0.0' },
        }),
      ],
      OPTS,
    );
    expect(plan.loadOrder).toContain('com.qa.solo');
    expect(plan.loadOrder).not.toContain('com.qa.needs');
    expect(plan.dropped).toContain('com.qa.needs');
    expect(
      plan.issues.some(
        (i) =>
          i.code === 'E_MISSING_DEPENDENCY' && i.pluginId === 'com.qa.needs',
      ),
    ).toBe(true);
  });

  it('硬依赖版本不符 → 依赖者被丢弃并报 E_VERSION_MISMATCH', () => {
    const resolver = new DependencyResolver();
    const plan = resolver.resolve(
      [
        makeCandidate({ id: 'com.qa.a', version: '1.0.0' }),
        makeCandidate({
          id: 'com.qa.b',
          dependencies: { 'com.qa.a': '^2.0.0' },
        }),
      ],
      OPTS,
    );
    expect(plan.loadOrder).toEqual(['com.qa.a']);
    expect(plan.dropped).toContain('com.qa.b');
    expect(plan.issues.some((i) => i.code === 'E_VERSION_MISMATCH')).toBe(true);
  });

  it('硬依赖被丢弃 → 级联丢弃整条链', () => {
    const resolver = new DependencyResolver();
    const plan = resolver.resolve(
      [
        makeCandidate({
          id: 'com.qa.top',
          dependencies: { 'com.qa.mid': '^1.0.0' },
        }),
        makeCandidate({
          id: 'com.qa.mid',
          dependencies: { 'com.qa.root': '^1.0.0' },
        }),
        // com.qa.root 缺失
        makeCandidate({ id: 'com.qa.other' }),
      ],
      OPTS,
    );
    expect(plan.dropped).toEqual(
      expect.arrayContaining(['com.qa.mid', 'com.qa.top']),
    );
    expect(plan.loadOrder).toEqual(['com.qa.other']);
  });
});

describe('resolver-boundary · 软依赖', () => {
  it('软依赖缺失 → 插件不被丢弃，仅产生 W_MISSING_OPTIONAL', () => {
    const resolver = new DependencyResolver();
    const plan = resolver.resolve(
      [
        makeCandidate({
          id: 'com.qa.a',
          optionalDependencies: { 'com.qa.opt': '^1.0.0' },
        }),
      ],
      OPTS,
    );
    expect(plan.loadOrder).toEqual(['com.qa.a']);
    expect(plan.dropped).toEqual([]);
    const warn = plan.issues.find((i) => i.code === 'W_MISSING_OPTIONAL');
    expect(warn?.level).toBe('warn');
  });

  it('软依赖版本不符 → 仍不丢弃，仅告警', () => {
    const resolver = new DependencyResolver();
    const plan = resolver.resolve(
      [
        makeCandidate({ id: 'com.qa.opt', version: '1.0.0' }),
        makeCandidate({
          id: 'com.qa.a',
          optionalDependencies: { 'com.qa.opt': '^9.0.0' },
        }),
      ],
      OPTS,
    );
    expect(plan.dropped).toEqual([]);
    expect(plan.loadOrder).toContain('com.qa.a');
    expect(plan.issues.some((i) => i.code === 'W_MISSING_OPTIONAL')).toBe(true);
  });
});

describe('resolver-boundary · 环与兼容性', () => {
  it('全硬边环 → 全部不加载并报 E_CYCLE', () => {
    const resolver = new DependencyResolver();
    const plan = resolver.resolve(
      [
        makeCandidate({
          id: 'com.qa.x',
          dependencies: { 'com.qa.y': '^1.0.0' },
        }),
        makeCandidate({
          id: 'com.qa.y',
          dependencies: { 'com.qa.x': '^1.0.0' },
        }),
      ],
      OPTS,
    );
    expect(plan.loadOrder).toEqual([]);
    expect(plan.issues.some((i) => i.code === 'E_CYCLE')).toBe(true);
  });

  it('契约 major 不符 → 丢弃并报 E_INCOMPATIBLE', () => {
    const resolver = new DependencyResolver();
    const plan = resolver.resolve(
      [
        makeCandidate({
          id: 'com.qa.a',
          compatibility: { contractVersion: '2' },
        }),
      ],
      OPTS,
    );
    expect(plan.loadOrder).toEqual([]);
    expect(plan.issues.some((i) => i.code === 'E_INCOMPATIBLE')).toBe(true);
  });

  it('重复 id → 去重为单个，并报 E_DUPLICATE_ID（warn）', () => {
    const resolver = new DependencyResolver();
    const plan = resolver.resolve(
      [
        makeCandidate({ id: 'com.qa.dup', source: 'user', version: '1.0.0' }),
        makeCandidate({
          id: 'com.qa.dup',
          source: 'builtin',
          version: '1.0.0',
        }),
      ],
      OPTS,
    );
    expect(plan.loadOrder).toEqual(['com.qa.dup']);
    expect(plan.issues.some((i) => i.code === 'E_DUPLICATE_ID')).toBe(true);
  });
});
