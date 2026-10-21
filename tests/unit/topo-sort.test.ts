import { describe, expect, it } from 'vitest'
import type { Candidate } from '../../src/kernel/discovery/candidate.js'
import { sourcePriorityRank } from '../../src/kernel/discovery/candidate.js'
import { buildGraph } from '../../src/kernel/dependency/graph.js'
import { topoSortedLoadOrder } from '../../src/kernel/dependency/topo-sort.js'

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
      dependencies: Object.fromEntries(deps.map(d => [d, '^1.0.0'])),
      compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
    },
    rootDir: `/plugins/${id}`,
    source,
    builtin: source === 'builtin',
    legacy: false,
  }
}

describe('dependency · deterministic topological sort', () => {
  it('dependencies dequeue before dependents', () => {
    const candidates = [cand('a', ['b']), cand('b', ['c']), cand('c')]
    const graph = buildGraph(candidates)
    const order = topoSortedLoadOrder(graph.nodes, graph.hardEdges, {
      priorityRank: c => sourcePriorityRank(c.source),
    })
    const idxB = order.indexOf('b')
    const idxA = order.indexOf('a')
    expect(idxB).toBeLessThan(idxA)
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('b'))
  })

  it('without dependencies, pluginId lexicographic order, deterministic', () => {
    const candidates = [cand('zeta'), cand('alpha'), cand('mid')]
    const graph = buildGraph(candidates)
    const order = topoSortedLoadOrder(graph.nodes, graph.hardEdges, {
      priorityRank: c => sourcePriorityRank(c.source),
    })
    expect(order).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('the output is completely identical after shuffling the input order (determinism)', () => {
    const run = (list: Candidate[]) => {
      const graph = buildGraph(list)
      return topoSortedLoadOrder(graph.nodes, graph.hardEdges, {
        priorityRank: c => sourcePriorityRank(c.source),
      })
    }
    const base = [
      cand('a', ['c']),
      cand('b', ['c']),
      cand('c'),
      cand('d', ['a']),
    ]
    const shuffled = [
      cand('d', ['a']),
      cand('c'),
      cand('a', ['c']),
      cand('b', ['c']),
    ]
    expect(run(base)).toEqual(run(shuffled))
  })

  it('source priority: builtin before user', () => {
    const candidates = [
      cand('user-plugin', [], 'user'),
      cand('builtin-plugin', [], 'builtin'),
    ]
    const graph = buildGraph(candidates)
    const order = topoSortedLoadOrder(graph.nodes, graph.hardEdges, {
      priorityRank: c => sourcePriorityRank(c.source),
    })
    expect(order[0]).toBe('builtin-plugin')
  })

  it('soft dependencies dequeue first given hard constraints', () => {
    const candidates = [cand('ui', []), cand('app', [])]
    const graph = buildGraph(candidates)
    // Manually inject a soft edge: app soft-depends on ui
    graph.softEdges.set('app', ['ui'])
    const order = topoSortedLoadOrder(graph.nodes, graph.hardEdges, {
      priorityRank: c => sourcePriorityRank(c.source),
      softEdges: graph.softEdges,
    })
    expect(order.indexOf('ui')).toBeLessThan(order.indexOf('app'))
  })

  it('a circular dependency causes the sort to fail and throw', () => {
    const candidates = [cand('a', ['b']), cand('b', ['a'])]
    const graph = buildGraph(candidates)
    expect(() =>
      topoSortedLoadOrder(graph.nodes, graph.hardEdges, {
        priorityRank: c => sourcePriorityRank(c.source),
      }),
    ).toThrow(/circular dependency/)
  })

  it('the diamond dependency order is assertable', () => {
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
    ]
    const graph = buildGraph(candidates)
    const order = topoSortedLoadOrder(graph.nodes, graph.hardEdges, {
      priorityRank: c => sourcePriorityRank(c.source),
    })
    expect(order.indexOf('d')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('d')).toBeLessThan(order.indexOf('c'))
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a'))
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('a'))
  })
})
