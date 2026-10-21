import { describe, expect, it } from 'vitest'
import {
  cycleNodes,
  findCycles,
  hasCycle,
} from '../../src/kernel/dependency/cycles.js'

describe('dependency · cycle detection (DFS three-color)', () => {
  it('an acyclic graph returns empty', () => {
    const graph = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', []],
    ])
    expect(findCycles(graph)).toEqual([])
    expect(hasCycle(graph)).toBe(false)
  })

  it('detects two-node cycles', () => {
    const graph = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['a']],
    ])
    const cycles = findCycles(graph)
    expect(cycles.length).toBe(1)
    const nodes = cycleNodes(cycles)
    expect(nodes.has('a')).toBe(true)
    expect(nodes.has('b')).toBe(true)
  })

  it('detects three-node cycles', () => {
    const graph = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ])
    const cycles = findCycles(graph)
    expect(cycles.length).toBe(1)
    expect(cycleNodes(cycles)).toEqual(new Set(['a', 'b', 'c']))
  })

  it('detects self-loops', () => {
    const graph = new Map<string, string[]>([['a', ['a']]])
    const cycles = findCycles(graph)
    expect(cycles.length).toBe(1)
    expect(cycles[0]).toEqual(['a', 'a'])
  })

  it('different rotations of the same cycle are not counted repeatedly', () => {
    const graph = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ])
    const cycles = findCycles(graph)
    expect(cycles.length).toBe(1)
  })

  it('multiple independent cycles are all detected', () => {
    const graph = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['a']],
      ['c', ['d']],
      ['d', ['c']],
    ])
    const cycles = findCycles(graph)
    expect(cycles.length).toBe(2)
    expect(cycleNodes(cycles)).toEqual(new Set(['a', 'b', 'c', 'd']))
  })

  it('handles isolated dependency nodes too', () => {
    const graph = new Map<string, string[]>([['a', ['external']]])
    expect(findCycles(graph)).toEqual([])
  })

  it('deterministic: repeated detection on the same graph agrees', () => {
    const make = () =>
      new Map<string, string[]>([
        ['a', ['b']],
        ['b', ['c']],
        ['c', ['a']],
      ])
    expect(findCycles(make())).toEqual(findCycles(make()))
  })
})
