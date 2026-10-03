/**
 * 依赖解析器（docs/02 §D）：版本兼容判定 + 冲突检测 + 循环检测 + 确定性拓扑排序。
 */

import type { Candidate, CandidateSource } from '../discovery/candidate.js';
import { sourcePriorityRank } from '../discovery/candidate.js';
import { satisfies, isValidRange } from '../semver/range.js';
import { parseVersion, type SemVer } from '../semver/semver.js';
import { buildGraph, mergeEdges, type DependencyGraph } from './graph.js';
import { findCycles, cycleNodes } from './cycles.js';
import { topoSortedLoadOrder } from './topo-sort.js';

/** 解析问题级别。 */
export type ResolveIssueLevel = 'error' | 'warn';

/** 解析问题码。 */
export type ResolveIssueCode =
  | 'E_DUPLICATE_ID'
  | 'E_MISSING_DEPENDENCY'
  | 'E_VERSION_MISMATCH'
  | 'E_CYCLE'
  | 'E_INCOMPATIBLE'
  | 'W_MISSING_OPTIONAL';

/** 解析问题。 */
export interface ResolveIssue {
  code: ResolveIssueCode;
  level: ResolveIssueLevel;
  pluginId: string;
  detail: string;
}

/** 解析步骤。 */
export interface ResolveStep {
  candidate: Candidate;
  resolvedDependencies: string[];
  missingOptional: string[];
}

/** 解析计划。 */
export interface ResolutionPlan {
  steps: ResolveStep[];
  loadOrder: string[];
  issues: ResolveIssue[];
  /** 被丢弃（不加载）的插件 id。 */
  dropped: string[];
}

/** 解析选项。 */
export interface ResolveOptions {
  kernelVersion: string;
  contractVersion: string;
  /** 'strict' 遇错即抛；'graceful' 丢弃出错插件继续（默认）。 */
  onError?: 'strict' | 'graceful';
}

const DEFAULT_ON_ERROR: 'strict' | 'graceful' = 'graceful';

/**
 * 依赖解析器。
 */
export class DependencyResolver {
  /**
   * 解析候选集为确定性加载计划。
   *
   * 处理顺序：
   * 1. 重复 id 去重（来源优先级 + 版本）
   * 2. 契约/内核兼容性校验（E_INCOMPATIBLE）
   * 3. 硬依赖缺失/版本不符（E_MISSING_DEPENDENCY / E_VERSION_MISMATCH）
   * 4. 软依赖缺失/版本不符（W_MISSING_OPTIONAL）
   * 5. 循环检测（硬环 → 全部丢弃；含软边 → 断裂软边）
   * 6. 确定性拓扑排序 → loadOrder
   */
  resolve(candidates: Candidate[], opts: ResolveOptions): ResolutionPlan {
    const onError = opts.onError ?? DEFAULT_ON_ERROR;
    const issues: ResolveIssue[] = [];
    const dropped = new Set<string>();

    // 1) 去重
    const byId = this.dedupe(candidates, issues);

    // 2) 兼容性校验
    for (const c of byId.values()) {
      const incompat = this.checkCompatibility(
        c,
        opts.kernelVersion,
        opts.contractVersion,
      );
      if (incompat.length > 0) {
        issues.push(...incompat);
        dropped.add(c.manifest.id);
      }
    }

    // 移除不兼容者后，再基于剩余集合检查依赖
    const active = new Map(
      Array.from(byId.entries()).filter(([id]) => !dropped.has(id)),
    );

    // 3)+4) 依赖校验
    for (const c of active.values()) {
      const id = c.manifest.id;

      // 硬依赖
      const deps = c.manifest.dependencies ?? {};
      for (const [depId, range] of Object.entries(deps)) {
        const target = active.get(depId);
        if (!target) {
          issues.push({
            code: 'E_MISSING_DEPENDENCY',
            level: 'error',
            pluginId: id,
            detail: `硬依赖缺失：${depId}@${range}`,
          });
          dropped.add(id);
          break;
        }
        if (!this.versionSatisfies(target.manifest.version, range)) {
          issues.push({
            code: 'E_VERSION_MISMATCH',
            level: 'error',
            pluginId: id,
            detail: `硬依赖版本不符：需要 ${depId}@${range}，实际 ${target.manifest.version}`,
          });
          dropped.add(id);
          break;
        }
      }

      if (dropped.has(id)) continue;

      // 软依赖
      const opts2 = c.manifest.optionalDependencies ?? {};
      for (const [depId, range] of Object.entries(opts2)) {
        const target = active.get(depId);
        if (!target) {
          issues.push({
            code: 'W_MISSING_OPTIONAL',
            level: 'warn',
            pluginId: id,
            detail: `软依赖缺失：${depId}@${range}（插件将进入 degraded）`,
          });
          continue;
        }
        if (!this.versionSatisfies(target.manifest.version, range)) {
          issues.push({
            code: 'W_MISSING_OPTIONAL',
            level: 'warn',
            pluginId: id,
            detail: `软依赖版本不符：需要 ${depId}@${range}，实际 ${target.manifest.version}`,
          });
        }
      }
    }

    // 反复移除"因硬依赖被丢弃而级联失败"的插件
    this.propagateDrops(active, dropped, issues);

    // 构建仅含存活插件的图
    const surviving = new Map(
      Array.from(active.entries()).filter(([id]) => !dropped.has(id)),
    );

    // 5) 循环检测
    const graph = buildGraph(Array.from(surviving.values()));
    const softBroken = this.breakSoftCycles(graph, surviving, issues, dropped);

    // 6) 拓扑排序（环节点已在 breakSoftCycles 中登记为 dropped）
    const loadOrder = this.sortSurviving(graph, surviving);

    // 组装 steps
    const steps: ResolveStep[] = loadOrder.map((id) => {
      const candidate = surviving.get(id)!;
      const resolvedDependencies = Object.keys(
        candidate.manifest.dependencies ?? {},
      ).filter((d) => surviving.has(d) && !dropped.has(d));
      const missingOptional = Object.keys(
        candidate.manifest.optionalDependencies ?? {},
      ).filter(
        (d) =>
          !softBroken.has(`${id}>${d}`) &&
          (!surviving.has(d) || dropped.has(d)),
      );
      return { candidate, resolvedDependencies, missingOptional };
    });

    if (onError === 'strict' && issues.some((i) => i.level === 'error')) {
      const first = issues.find((i) => i.level === 'error')!;
      throw new Error(
        `依赖解析失败（strict）：${first.code} - ${first.detail}`,
      );
    }

    return { steps, loadOrder, issues, dropped: Array.from(dropped).sort() };
  }

  /** 版本是否满足 range。 */
  satisfies(version: string, range: string): boolean {
    return this.versionSatisfies(version, range);
  }

  /** 便捷：拓扑排序（对外保留，见类图）。 */
  topoSort(candidates: Candidate[]): string[] {
    const graph = buildGraph(candidates);
    return this.sortSurviving(graph, graph.nodes);
  }

  /** 便捷：循环检测（对外保留）。 */
  detectCycles(graph: Map<string, string[]>): string[][] {
    return findCycles(graph);
  }

  // ───────────────────────── 内部实现 ─────────────────────────

  private versionSatisfies(version: string, range: string): boolean {
    if (!isValidRange(range)) {
      // 非法 range 视为精确匹配失败，但避免抛错影响整体流程。
      try {
        return (
          parseVersion(version).major === parseVersion(range).major &&
          parseVersion(version).minor === parseVersion(range).minor &&
          parseVersion(version).patch === parseVersion(range).patch
        );
      } catch {
        return false;
      }
    }
    return satisfies(version, range);
  }

  /** 去重：同一 id 保留「来源优先级更高 / 版本更高」者，其余 warn。 */
  private dedupe(
    candidates: Candidate[],
    issues: ResolveIssue[],
  ): Map<string, Candidate> {
    const byId = new Map<string, Candidate>();
    for (const c of candidates) {
      const id = c.manifest.id;
      const existing = byId.get(id);
      if (!existing) {
        byId.set(id, c);
        continue;
      }
      const winner = this.pickWinner(existing, c);
      const loser = winner === existing ? c : existing;
      byId.set(id, winner);
      issues.push({
        code: 'E_DUPLICATE_ID',
        level: 'warn',
        pluginId: id,
        detail: `重复插件 id：保留 ${winner.source}@${winner.manifest.version}，忽略 ${loser.source}@${loser.manifest.version}`,
      });
    }
    return byId;
  }

  private pickWinner(a: Candidate, b: Candidate): Candidate {
    const ra = sourcePriorityRank(a.source as CandidateSource);
    const rb = sourcePriorityRank(b.source as CandidateSource);
    // 来源优先级数值越小越优先（builtin < workspace < user）。
    if (ra !== rb) return ra < rb ? a : b;
    try {
      const va: SemVer = parseVersion(a.manifest.version);
      const vb: SemVer = parseVersion(b.manifest.version);
      if (va.major !== vb.major) return va.major > vb.major ? a : b;
      if (va.minor !== vb.minor) return va.minor > vb.minor ? a : b;
      if (va.patch !== vb.patch) return va.patch > vb.patch ? a : b;
    } catch {
      // 忽略，退回 a
    }
    return a;
  }

  /** 兼容性校验。 */
  private checkCompatibility(
    c: Candidate,
    kernelVersion: string,
    contractVersion: string,
  ): ResolveIssue[] {
    const issues: ResolveIssue[] = [];
    const compat = c.manifest.compatibility;
    if (!compat) {
      issues.push({
        code: 'E_INCOMPATIBLE',
        level: 'error',
        pluginId: c.manifest.id,
        detail: '缺少 compatibility 声明',
      });
      return issues;
    }

    // 契约 major 比对
    const kernelMajor = contractMajor(contractVersion);
    const pluginMajor = contractMajor(compat.contractVersion);
    if (kernelMajor !== pluginMajor) {
      issues.push({
        code: 'E_INCOMPATIBLE',
        level: 'error',
        pluginId: c.manifest.id,
        detail: `契约版本不兼容：内核 ${contractVersion}，插件 ${compat.contractVersion}`,
      });
    }

    // 内核版本区间
    if (compat.minKernel) {
      const ok = isValidRange(compat.minKernel)
        ? satisfies(kernelVersion, compat.minKernel)
        : this.versionSatisfies(kernelVersion, compat.minKernel);
      if (!ok) {
        issues.push({
          code: 'E_INCOMPATIBLE',
          level: 'error',
          pluginId: c.manifest.id,
          detail: `内核版本过低：需要 ${compat.minKernel}，内核 ${kernelVersion}`,
        });
      }
    }
    if (compat.maxKernel) {
      try {
        const kernel = parseVersion(kernelVersion);
        const max = parseVersion(compat.maxKernel);
        if (
          kernel.major > max.major ||
          (kernel.major === max.major && compareTuple(kernel, max) > 0)
        ) {
          issues.push({
            code: 'E_INCOMPATIBLE',
            level: 'error',
            pluginId: c.manifest.id,
            detail: `内核版本过高：最大 ${compat.maxKernel}，内核 ${kernelVersion}`,
          });
        }
      } catch {
        // ignore malformed maxKernel
      }
    }
    return issues;
  }

  /**
   * 处理软依赖导致的环：断裂 id 最小的软边（确定性），产出 W_MISSING_OPTIONAL。
   * 返回被断裂的软边集合 `pluginId>depId`。
   */
  private breakSoftCycles(
    graph: DependencyGraph,
    surviving: Map<string, Candidate>,
    issues: ResolveIssue[],
    dropped: Set<string>,
  ): Set<string> {
    const broken = new Set<string>();
    // 迭代：每次断裂一条软边，直到无环。
    for (let guard = 0; guard < 100; guard += 1) {
      const merged = mergeEdges(graph);
      const cycles = findCycles(merged);
      if (cycles.length === 0) break;

      let removed = false;
      for (const cycle of cycles) {
        // 找出环上所有「软边」候选（from -> to 且该边来自 soft）
        const softCandidates: Array<{ key: string; from: string; to: string }> =
          [];
        for (let i = 0; i < cycle.length - 1; i += 1) {
          const from = cycle[i]!;
          const to = cycle[i + 1]!;
          const soft = graph.softEdges.get(from) ?? [];
          if (soft.includes(to)) {
            softCandidates.push({ key: `${from}>${to}`, from, to });
          }
        }

        if (softCandidates.length === 0) {
          // 全硬边环：全部丢弃。
          const nodes = cycleNodes([cycle]);
          for (const id of nodes) {
            if (surviving.has(id)) {
              // 必须同时登记为 dropped，否则这些节点会从 loadOrder 里静默消失
              // （拓扑排序无法输出环节点），而 plan.dropped 却不含它们 —— 观测不一致。
              dropped.add(id);
              issues.push({
                code: 'E_CYCLE',
                level: 'error',
                pluginId: id,
                detail: `循环依赖（全硬边）：${cycle.join(' -> ')}`,
              });
            }
          }
          continue;
        }

        // 选 id 最小的软边断裂（确定性）
        softCandidates.sort((a, b) => a.key.localeCompare(b.key, 'en'));
        const chosen = softCandidates[0]!;
        broken.add(chosen.key);
        graph.softEdges.set(
          chosen.from,
          (graph.softEdges.get(chosen.from) ?? []).filter(
            (d) => d !== chosen.to,
          ),
        );
        issues.push({
          code: 'W_MISSING_OPTIONAL',
          level: 'warn',
          pluginId: chosen.from,
          detail: `循环依赖含软边，自动断裂软依赖：${chosen.from} -> ${chosen.to}`,
        });
        removed = true;
        break; // 重新检测（图已变化）
      }
      if (!removed) break;
    }
    return broken;
  }

  /** 对存活集合做拓扑排序（仅硬边）；若全硬边环导致排序失败，则剔除环节点重排。 */
  private sortSurviving(
    graph: DependencyGraph,
    _surviving: Map<string, Candidate>,
  ): string[] {
    const nodes = graph.nodes;
    const hardEdges = graph.hardEdges;
    try {
      return topoSortedLoadOrder(nodes, hardEdges, {
        priorityRank: (c) => sourcePriorityRank(c.source),
        softEdges: graph.softEdges,
      });
    } catch {
      // 兜底：移除仍存在硬环的节点后重排（正常流程不应到达此处）。
      const merged = new Map<string, string[]>();
      for (const [k, v] of hardEdges) merged.set(k, v);
      const cycleSet = cycleNodes(findCycles(merged));
      const filtered = new Map(
        Array.from(nodes.entries()).filter(([id]) => !cycleSet.has(id)),
      );
      if (filtered.size === 0) return [];
      const filteredEdges = new Map<string, string[]>();
      for (const [k, v] of hardEdges) {
        if (!cycleSet.has(k))
          filteredEdges.set(
            k,
            v.filter((d) => !cycleSet.has(d)),
          );
      }
      return topoSortedLoadOrder(filtered, filteredEdges, {
        priorityRank: (c) => sourcePriorityRank(c.source),
        softEdges: graph.softEdges,
      });
    }
  }

  /** 级联丢弃：硬依赖被丢弃的插件也随之丢弃。 */
  private propagateDrops(
    active: Map<string, Candidate>,
    dropped: Set<string>,
    issues: ResolveIssue[],
  ): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, c] of active) {
        if (dropped.has(id)) continue;
        const deps = Object.keys(c.manifest.dependencies ?? {});
        const bad = deps.find((d) => dropped.has(d));
        if (bad) {
          dropped.add(id);
          issues.push({
            code: 'E_MISSING_DEPENDENCY',
            level: 'error',
            pluginId: id,
            detail: `依赖被丢弃，级联失败：${bad}`,
          });
          changed = true;
        }
      }
    }
  }
}

/** 取契约 major（如 '1' / '1.0' / '1.2' → 1）。 */
function contractMajor(v: string): number {
  const head = String(v).split('.')[0] ?? '0';
  const n = Number(head);
  return Number.isNaN(n) ? 0 : n;
}

function compareTuple(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}
