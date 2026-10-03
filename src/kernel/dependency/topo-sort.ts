/**
 * 确定性拓扑排序（docs/02 §D.4，动机 #2）。
 *
 * 算法：Kahn 算法 + 三级全序排序键，保证「相同节点集、任意输入顺序」下
 * 输出 `loadOrder` 逐元素一致。
 *
 * 排序键（升序优先出队）：
 * 1) priorityRank 升序：builtin(0) < workspace(1) < user(2)
 * 2) pluginId 字典序升序（localeCompare 'en'）
 * 3) version 降序（同 id 多版本场景）
 */

import type { Candidate } from '../discovery/candidate.js';
import { compareVersions } from '../semver/semver.js';

/** 优先级排序键。 */
export interface TopoSortOptions {
  /** 计算候选的 priorityRank（越小越优先）。 */
  priorityRank: (c: Candidate) => number;
  /** 软依赖排序优化：pluginId -> 其软依赖 id 列表（存在时尽量先出队）。 */
  softEdges?: Map<string, string[]>;
}

/** 候选比较器（全序）。 */
function compareCandidates(
  a: Candidate,
  b: Candidate,
  rank: (c: Candidate) => number,
): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;

  const idCmp = a.manifest.id.localeCompare(b.manifest.id, 'en');
  if (idCmp !== 0) return idCmp;

  // 同 id 时按版本降序（字母序大者先出队）。
  try {
    return -compareVersions(a.manifest.version, b.manifest.version);
  } catch {
    return 0;
  }
}

/**
 * 计算确定性加载顺序。
 *
 * @param nodes      参与排序的候选（id -> Candidate）
 * @param hardEdges  pluginId -> 其硬依赖 id 列表（依赖先于依赖者）
 * @param opts       排序选项
 * @returns 有序 pluginId 列表
 * @throws 若存在环（调用方应先做循环检测）
 */
export function topoSortedLoadOrder(
  nodes: Map<string, Candidate>,
  hardEdges: Map<string, string[]>,
  opts: TopoSortOptions,
): string[] {
  const ids = Array.from(nodes.keys());
  const idSet = new Set(ids);

  // 入度 = 该节点依赖的「存在于图中的」硬依赖数量。
  const indegree = new Map<string, number>();
  // 反向边：dep -> [依赖它的节点]。
  const dependents = new Map<string, string[]>();

  for (const id of ids) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }

  for (const id of ids) {
    const deps = (hardEdges.get(id) ?? []).filter((d) => idSet.has(d));
    indegree.set(id, deps.length);
    for (const d of deps) {
      dependents.get(d)!.push(id);
    }
  }

  // 就绪集合，使用「取最小键」的策略模拟优先队列，保证确定性。
  const ready: string[] = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  const order: string[] = [];

  const rank = opts.priorityRank;
  const soft = opts.softEdges;

  const pickMin = (): string => {
    // 先按基础全序排序（sort 在等值时不稳定，因此比较器必须全序）。
    ready.sort((x, y) => {
      const cx = nodes.get(x)!;
      const cy = nodes.get(y)!;

      // 软依赖优先：若 y 软依赖 x（x 被 y 依赖），则 x 应更早出队。
      const xBeforeY = (soft?.get(y) ?? []).includes(x);
      const yBeforeX = (soft?.get(x) ?? []).includes(y);
      if (xBeforeY && !yBeforeX) return -1;
      if (yBeforeX && !xBeforeY) return 1;

      return compareCandidates(cx, cy, rank);
    });
    return ready.shift()!;
  };

  while (ready.length > 0) {
    const id = pickMin();
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
      }
    }
  }

  if (order.length !== ids.length) {
    const remaining = ids.filter((id) => !order.includes(id));
    throw new Error(
      `拓扑排序失败：存在循环依赖，涉及节点：${remaining.join(', ')}`,
    );
  }

  return order;
}
