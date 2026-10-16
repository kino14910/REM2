import { describe, expect, it } from 'vitest';
import type { Candidate } from '../../src/kernel/discovery/candidate.js';
import { sourcePriorityRank } from '../../src/kernel/discovery/candidate.js';
import { buildGraph } from '../../src/kernel/dependency/graph.js';
import { topoSortedLoadOrder } from '../../src/kernel/dependency/topo-sort.js';

function cand(
  id: string,
  deps: string[] = [],
  source: Candidate['source'] = 'builtin',
): Candidate {
  return {
    manifest: {
      id,
      name: id,
      version: '1.0.0',
      entry: 'dist/index.js',
      dependencies: Object.fromEntries(deps.map((d) => [d, '^1.0.0'])),
      compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
    },
    rootDir: `/plugins/${id}`,
    source,
    builtin: source === 'builtin',
    legacy: false,
  };
}

describe('dependency · 确定性拓扑排序', () => {
  it('依赖先于依赖者出队', () => {
    const candidates = [cand('a', ['b']), cand('b', ['c']), cand('c')];
    const graph = buildGraph(candidates);
    const order = topoSortedLoadOrder(graph.nodes, graph.hardEdges, {
      priorityRank: (c) => sourcePriorityRank(c.source),
    });
    const idxB = order.indexOf('b');
    const idxA = order.indexOf('a');
    expect(idxB).toBeLessThan(idxA);
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('b'));
  });

  it('无依赖时按 pluginId 字典序，结果确定', () => {
    const candidates = [cand('zeta'), cand('alpha'), cand('mid')];
    const graph = buildGraph(candidates);
    const order = topoSortedLoadOrder(graph.nodes, graph.hardEdges, {
      priorityRank: (c) => sourcePriorityRank(c.source),
    });
    expect(order).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('输入顺序打乱后输出完全一致（确定性）', () => {
    const run = (list: Candidate[]) => {
      const graph = buildGraph(list);
      return topoSortedLoadOrder(graph.nodes, graph.hardEdges, {
        priorityRank: (c) => sourcePriorityRank(c.source),
      });
    };
    const base = [
      cand('a', ['c']),
      cand('b', ['c']),
      cand('c'),
      cand('d', ['a']),
    ];
    const shuffled = [
      cand('d', ['a']),
      cand('c'),
      cand('a', ['c']),
      cand('b', ['c']),
    ];
    expect(run(base)).toEqual(run(shuffled));
  });

  it('来源优先级：builtin 先于 user', () => {
    const candidates = [
      cand('user-plugin', [], 'user'),
      cand('builtin-plugin', [], 'builtin'),
    ];
    const graph = buildGraph(candidates);
    const order = topoSortedLoadOrder(graph.nodes, graph.hardEdges, {
      priorityRank: (c) => sourcePriorityRank(c.source),
    });
    expect(order[0]).toBe('builtin-plugin');
  });

  it('软依赖在有硬约束前提下优先出队', () => {
    const candidates = [cand('ui', []), cand('app', [])];
    const graph = buildGraph(candidates);
    // 手动注入软边：app 软依赖 ui
    graph.softEdges.set('app', ['ui']);
    const order = topoSortedLoadOrder(graph.nodes, graph.hardEdges, {
      priorityRank: (c) => sourcePriorityRank(c.source),
      softEdges: graph.softEdges,
    });
    expect(order.indexOf('ui')).toBeLessThan(order.indexOf('app'));
  });

  it('循环依赖导致排序失败并抛错', () => {
    const candidates = [cand('a', ['b']), cand('b', ['a'])];
    const graph = buildGraph(candidates);
    expect(() =>
      topoSortedLoadOrder(graph.nodes, graph.hardEdges, {
        priorityRank: (c) => sourcePriorityRank(c.source),
      }),
    ).toThrow(/循环依赖/);
  });

  it('钻石依赖顺序可断言', () => {
    //   a
    //  / \
    // b   c
    //  \ /
    //   d
    const candidates = [
      cand('a', ['b', 'c']),
      cand('b', ['d']),
      cand('c', ['d']),
      cand('d'),
    ];
    const graph = buildGraph(candidates);
    const order = topoSortedLoadOrder(graph.nodes, graph.hardEdges, {
      priorityRank: (c) => sourcePriorityRank(c.source),
    });
    expect(order.indexOf('d')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('d')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('a'));
  });
});
