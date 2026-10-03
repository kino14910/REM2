/**
 * 依赖图构建（docs/02 §D.4）。
 *
 * 输入候选集，输出：
 * - 硬依赖边（参与拓扑约束）
 * - 软依赖边（不参与拓扑约束，仅用于软排序优化）
 */

import type { Candidate } from '../discovery/candidate.js';

/** 依赖图。 */
export interface DependencyGraph {
  /** pluginId -> 其硬依赖 id 列表（已去重、保持插入顺序）。 */
  hardEdges: Map<string, string[]>;
  /** pluginId -> 其软依赖 id 列表。 */
  softEdges: Map<string, string[]>;
  /** pluginId -> 候选（含被软依赖指向但可能不存在的 id 不会出现在这里）。 */
  nodes: Map<string, Candidate>;
}

/**
 * 构建依赖图。
 *
 * 硬依赖边只包含「在候选集中真实存在」的依赖；缺失依赖的记录由 resolver 负责产出 issue。
 *
 * @param candidates 候选插件集（重复 id 已由 resolver 去重后传入）
 */
export function buildGraph(candidates: Candidate[]): DependencyGraph {
  const nodes = new Map<string, Candidate>();
  const hardEdges = new Map<string, string[]>();
  const softEdges = new Map<string, string[]>();

  const ids = new Set(candidates.map((c) => c.manifest.id));

  for (const c of candidates) {
    const id = c.manifest.id;
    nodes.set(id, c);

    const hard: string[] = [];
    const deps = c.manifest.dependencies ?? {};
    for (const dep of Object.keys(deps)) {
      if (ids.has(dep) && dep !== id) {
        hard.push(dep);
      }
    }
    hardEdges.set(id, dedupe(hard));

    const soft: string[] = [];
    const opts = c.manifest.optionalDependencies ?? {};
    for (const dep of Object.keys(opts)) {
      if (ids.has(dep) && dep !== id) {
        soft.push(dep);
      }
    }
    softEdges.set(id, dedupe(soft));
  }

  return { hardEdges, softEdges, nodes };
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

/**
 * 构建「含软依赖」的合并图，仅用于循环检测（软边可被自动断裂，见 docs/02 §D.5）。
 */
export function mergeEdges(graph: DependencyGraph): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const [id, hard] of graph.hardEdges) {
    const soft = graph.softEdges.get(id) ?? [];
    merged.set(id, dedupe([...hard, ...soft]));
  }
  return merged;
}
