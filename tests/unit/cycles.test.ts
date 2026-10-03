import { describe, expect, it } from 'vitest';
import {
  cycleNodes,
  findCycles,
  hasCycle,
} from '../../src/kernel/dependency/cycles.js';

describe('dependency · 循环检测（DFS 三色）', () => {
  it('无环图返回空', () => {
    const graph = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', []],
    ]);
    expect(findCycles(graph)).toEqual([]);
    expect(hasCycle(graph)).toBe(false);
  });

  it('检测二元环', () => {
    const graph = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['a']],
    ]);
    const cycles = findCycles(graph);
    expect(cycles.length).toBe(1);
    const nodes = cycleNodes(cycles);
    expect(nodes.has('a')).toBe(true);
    expect(nodes.has('b')).toBe(true);
  });

  it('检测三元环', () => {
    const graph = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ]);
    const cycles = findCycles(graph);
    expect(cycles.length).toBe(1);
    expect(cycleNodes(cycles)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('检测自环', () => {
    const graph = new Map<string, string[]>([['a', ['a']]]);
    const cycles = findCycles(graph);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toEqual(['a', 'a']);
  });

  it('同一环的不同旋转不重复计数', () => {
    const graph = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ]);
    const cycles = findCycles(graph);
    expect(cycles.length).toBe(1);
  });

  it('多个独立环全部检出', () => {
    const graph = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['a']],
      ['c', ['d']],
      ['d', ['c']],
    ]);
    const cycles = findCycles(graph);
    expect(cycles.length).toBe(2);
    expect(cycleNodes(cycles)).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  it('包含孤立依赖节点也能处理', () => {
    const graph = new Map<string, string[]>([['a', ['external']]]);
    expect(findCycles(graph)).toEqual([]);
  });

  it('结果确定：同图多次检测结果一致', () => {
    const make = () =>
      new Map<string, string[]>([
        ['a', ['b']],
        ['b', ['c']],
        ['c', ['a']],
      ]);
    expect(findCycles(make())).toEqual(findCycles(make()));
  });
});
