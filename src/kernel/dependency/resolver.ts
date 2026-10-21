import type { Candidate, CandidateSource } from '../discovery/candidate.js'
import { sourcePriorityRank } from '../discovery/candidate.js'
import { satisfies, isValidRange } from '../semver/range.js'
import { parseVersion, type SemVer } from '../semver/semver.js'
import { buildGraph, mergeEdges, type DependencyGraph } from './graph.js'
import { findCycles, cycleNodes } from './cycles.js'
import { topoSortedLoadOrder } from './topo-sort.js'

export type ResolveIssueLevel = 'error' | 'warn'

export type ResolveIssueCode =
  | 'E_DUPLICATE_ID'
  | 'E_MISSING_DEPENDENCY'
  | 'E_VERSION_MISMATCH'
  | 'E_CYCLE'
  | 'E_INCOMPATIBLE'
  | 'W_MISSING_OPTIONAL'

export interface ResolveIssue {
  code: ResolveIssueCode
  level: ResolveIssueLevel
  pluginId: string
  detail: string
}

export interface ResolveStep {
  candidate: Candidate
  resolvedDependencies: string[]
  missingOptional: string[]
}

export interface ResolutionPlan {
  steps: ResolveStep[]
  loadOrder: string[]
  issues: ResolveIssue[]
  dropped: string[]
}

export interface ResolveOptions {
  kernelVersion: string
  contractVersion: string
  /** 'strict' throws on the first error; 'graceful' drops failing plugins and continues (default). */
  onError?: 'strict' | 'graceful'
}

const DEFAULT_ON_ERROR: 'strict' | 'graceful' = 'graceful'

export class DependencyResolver {
  /**
   * Resolve a candidate set into a deterministic load plan.
   *
   * Pipeline:
   * 1. Dedupe duplicate ids (source priority, then version)
   * 2. Contract/kernel compatibility checks (E_INCOMPATIBLE)
   * 3. Hard dependency missing/version mismatch (E_MISSING_DEPENDENCY / E_VERSION_MISMATCH)
   * 4. Soft dependency missing/version mismatch (W_MISSING_OPTIONAL)
   * 5. Cycle detection (all-hard cycle -> drop all nodes; cycle with soft edges -> break a soft edge)
   * 6. Deterministic topological sort -> loadOrder
   */
  resolve(candidates: Candidate[], opts: ResolveOptions): ResolutionPlan {
    const onError = opts.onError ?? DEFAULT_ON_ERROR
    const issues: ResolveIssue[] = []
    const dropped = new Set<string>()

    const byId = this.dedupe(candidates, issues)

    for (const c of byId.values()) {
      const incompat = this.checkCompatibility(
        c,
        opts.kernelVersion,
        opts.contractVersion,
      )
      if (incompat.length > 0) {
        issues.push(...incompat)
        dropped.add(c.manifest.id)
      }
    }

    // After removing incompatible plugins, check dependencies against the remaining set.
    const active = new Map(
      Array.from(byId.entries()).filter(([id]) => !dropped.has(id)),
    )

    for (const c of active.values()) {
      const id = c.manifest.id

      const deps = c.manifest.dependencies ?? {}
      for (const [depId, range] of Object.entries(deps)) {
        const target = active.get(depId)
        if (!target) {
          issues.push({
            code: 'E_MISSING_DEPENDENCY',
            level: 'error',
            pluginId: id,
            detail: `missing hard dependency: ${depId}@${range}`,
          })
          dropped.add(id)
          break
        }
        if (!this.versionSatisfies(target.manifest.version, range)) {
          issues.push({
            code: 'E_VERSION_MISMATCH',
            level: 'error',
            pluginId: id,
            detail: `hard dependency version mismatch: requires ${depId}@${range}, found ${target.manifest.version}`,
          })
          dropped.add(id)
          break
        }
      }

      if (dropped.has(id)) continue

      const opts2 = c.manifest.optionalDependencies ?? {}
      for (const [depId, range] of Object.entries(opts2)) {
        const target = active.get(depId)
        if (!target) {
          issues.push({
            code: 'W_MISSING_OPTIONAL',
            level: 'warn',
            pluginId: id,
            detail: `missing soft dependency: ${depId}@${range} (plugin will run degraded)`,
          })
          continue
        }
        if (!this.versionSatisfies(target.manifest.version, range)) {
          issues.push({
            code: 'W_MISSING_OPTIONAL',
            level: 'warn',
            pluginId: id,
            detail: `soft dependency version mismatch: requires ${depId}@${range}, found ${target.manifest.version}`,
          })
        }
      }
    }

    this.propagateDrops(active, dropped, issues)

    const surviving = new Map(
      Array.from(active.entries()).filter(([id]) => !dropped.has(id)),
    )

    const graph = buildGraph(Array.from(surviving.values()))
    const softBroken = this.breakSoftCycles(graph, surviving, issues, dropped)

    // 6) Topological sort (cycle nodes are already registered as dropped in breakSoftCycles)
    const loadOrder = this.sortSurviving(graph, surviving)

    const steps: ResolveStep[] = loadOrder.map(id => {
      const candidate = surviving.get(id)!
      const resolvedDependencies = Object.keys(
        candidate.manifest.dependencies ?? {},
      ).filter(d => surviving.has(d) && !dropped.has(d))
      const missingOptional = Object.keys(
        candidate.manifest.optionalDependencies ?? {},
      ).filter(
        d =>
          !softBroken.has(`${id}>${d}`) &&
          (!surviving.has(d) || dropped.has(d)),
      )
      return { candidate, resolvedDependencies, missingOptional }
    })

    if (onError === 'strict' && issues.some(i => i.level === 'error')) {
      const first = issues.find(i => i.level === 'error')!
      throw new Error(
        `dependency resolution failed (strict): ${first.code} - ${first.detail}`,
      )
    }

    return { steps, loadOrder, issues, dropped: Array.from(dropped).sort() }
  }

  satisfies(version: string, range: string): boolean {
    return this.versionSatisfies(version, range)
  }

  topoSort(candidates: Candidate[]): string[] {
    const graph = buildGraph(candidates)
    return this.sortSurviving(graph, graph.nodes)
  }

  detectCycles(graph: Map<string, string[]>): string[][] {
    return findCycles(graph)
  }

  // ---- Internal implementation ----

  private versionSatisfies(version: string, range: string): boolean {
    if (!isValidRange(range)) {
      // Fall back to an exact version match for invalid ranges; parse errors are swallowed to avoid disrupting the overall flow.
      try {
        return (
          parseVersion(version).major === parseVersion(range).major &&
          parseVersion(version).minor === parseVersion(range).minor &&
          parseVersion(version).patch === parseVersion(range).patch
        )
      } catch {
        return false
      }
    }
    return satisfies(version, range)
  }

  /** Dedupe: per id, keep the candidate with the higher source priority or higher version; warn about the rest. */
  private dedupe(
    candidates: Candidate[],
    issues: ResolveIssue[],
  ): Map<string, Candidate> {
    const byId = new Map<string, Candidate>()
    for (const c of candidates) {
      const id = c.manifest.id
      const existing = byId.get(id)
      if (!existing) {
        byId.set(id, c)
        continue
      }
      const winner = this.pickWinner(existing, c)
      const loser = winner === existing ? c : existing
      byId.set(id, winner)
      issues.push({
        code: 'E_DUPLICATE_ID',
        level: 'warn',
        pluginId: id,
        detail: `duplicate plugin id: keeping ${winner.source}@${winner.manifest.version}, ignoring ${loser.source}@${loser.manifest.version}`,
      })
    }
    return byId
  }

  private pickWinner(a: Candidate, b: Candidate): Candidate {
    const ra = sourcePriorityRank(a.source as CandidateSource)
    const rb = sourcePriorityRank(b.source as CandidateSource)
    // Lower source priority rank wins (builtin < workspace < user).
    if (ra !== rb) return ra < rb ? a : b
    try {
      const va: SemVer = parseVersion(a.manifest.version)
      const vb: SemVer = parseVersion(b.manifest.version)
      if (va.major !== vb.major) return va.major > vb.major ? a : b
      if (va.minor !== vb.minor) return va.minor > vb.minor ? a : b
      if (va.patch !== vb.patch) return va.patch > vb.patch ? a : b
    } catch {}
    return a
  }

  private checkCompatibility(
    c: Candidate,
    kernelVersion: string,
    contractVersion: string,
  ): ResolveIssue[] {
    const issues: ResolveIssue[] = []
    const compat = c.manifest.compatibility
    if (!compat) {
      issues.push({
        code: 'E_INCOMPATIBLE',
        level: 'error',
        pluginId: c.manifest.id,
        detail: 'missing compatibility declaration',
      })
      return issues
    }

    const kernelMajor = contractMajor(contractVersion)
    const pluginMajor = contractMajor(compat.contractVersion)
    if (kernelMajor !== pluginMajor) {
      issues.push({
        code: 'E_INCOMPATIBLE',
        level: 'error',
        pluginId: c.manifest.id,
        detail: `contract version incompatible: kernel ${contractVersion}, plugin ${compat.contractVersion}`,
      })
    }

    if (compat.minKernel) {
      const ok = isValidRange(compat.minKernel)
        ? satisfies(kernelVersion, compat.minKernel)
        : this.versionSatisfies(kernelVersion, compat.minKernel)
      if (!ok) {
        issues.push({
          code: 'E_INCOMPATIBLE',
          level: 'error',
          pluginId: c.manifest.id,
          detail: `kernel version too low: requires ${compat.minKernel}, kernel ${kernelVersion}`,
        })
      }
    }
    if (compat.maxKernel) {
      try {
        const kernel = parseVersion(kernelVersion)
        const max = parseVersion(compat.maxKernel)
        if (
          kernel.major > max.major ||
          (kernel.major === max.major && compareTuple(kernel, max) > 0)
        ) {
          issues.push({
            code: 'E_INCOMPATIBLE',
            level: 'error',
            pluginId: c.manifest.id,
            detail: `kernel version too high: max ${compat.maxKernel}, kernel ${kernelVersion}`,
          })
        }
      } catch {
        // ignore malformed maxKernel
      }
    }
    return issues
  }

  /**
   * Break cycles caused by soft dependencies: deterministically break the soft edge with the smallest id, emitting W_MISSING_OPTIONAL.
   * Returns the set of broken soft edges as `pluginId>depId`.
   */
  private breakSoftCycles(
    graph: DependencyGraph,
    surviving: Map<string, Candidate>,
    issues: ResolveIssue[],
    dropped: Set<string>,
  ): Set<string> {
    const broken = new Set<string>()
    // Iterate: break one soft edge at a time until no cycles remain.
    for (let guard = 0; guard < 100; guard += 1) {
      const merged = mergeEdges(graph)
      const cycles = findCycles(merged)
      if (cycles.length === 0) break

      let removed = false
      for (const cycle of cycles) {
        const softCandidates: Array<{ key: string; from: string; to: string }> =
          []
        for (let i = 0; i < cycle.length - 1; i += 1) {
          const from = cycle[i]!
          const to = cycle[i + 1]!
          const soft = graph.softEdges.get(from) ?? []
          if (soft.includes(to)) {
            softCandidates.push({ key: `${from}>${to}`, from, to })
          }
        }

        if (softCandidates.length === 0) {
          // All-hard-edge cycle: drop every node on it.
          const nodes = cycleNodes([cycle])
          for (const id of nodes) {
            if (surviving.has(id)) {
              // These must also be registered as dropped; otherwise they silently vanish from loadOrder
              // (topological sort cannot emit cycle nodes) while plan.dropped omits them - an observability inconsistency.
              dropped.add(id)
              issues.push({
                code: 'E_CYCLE',
                level: 'error',
                pluginId: id,
                detail: `circular dependency (all hard edges): ${cycle.join(' -> ')}`,
              })
            }
          }
          continue
        }

        // Break the soft edge with the smallest id (deterministic).
        softCandidates.sort((a, b) => a.key.localeCompare(b.key, 'en'))
        const chosen = softCandidates[0]!
        broken.add(chosen.key)
        graph.softEdges.set(
          chosen.from,
          (graph.softEdges.get(chosen.from) ?? []).filter(d => d !== chosen.to),
        )
        issues.push({
          code: 'W_MISSING_OPTIONAL',
          level: 'warn',
          pluginId: chosen.from,
          detail: `circular dependency contains a soft edge breaking the soft dependency automatically: ${chosen.from} -> ${chosen.to}`,
        })
        removed = true
        break // Re-detect cycles (the graph has changed)
      }
      if (!removed) break
    }
    return broken
  }

  /** Topologically sort the surviving set (hard edges only); if an all-hard cycle makes sorting fail, remove the cycle nodes and retry. */
  private sortSurviving(
    graph: DependencyGraph,
    _surviving: Map<string, Candidate>,
  ): string[] {
    const nodes = graph.nodes
    const hardEdges = graph.hardEdges
    try {
      return topoSortedLoadOrder(nodes, hardEdges, {
        priorityRank: c => sourcePriorityRank(c.source),
        softEdges: graph.softEdges,
      })
    } catch {
      // Fallback: remove nodes still in a hard cycle and retry (the normal flow should never reach here).
      const merged = new Map<string, string[]>()
      for (const [k, v] of hardEdges) merged.set(k, v)
      const cycleSet = cycleNodes(findCycles(merged))
      const filtered = new Map(
        Array.from(nodes.entries()).filter(([id]) => !cycleSet.has(id)),
      )
      if (filtered.size === 0) return []
      const filteredEdges = new Map<string, string[]>()
      for (const [k, v] of hardEdges) {
        if (!cycleSet.has(k))
          filteredEdges.set(
            k,
            v.filter(d => !cycleSet.has(d)),
          )
      }
      return topoSortedLoadOrder(filtered, filteredEdges, {
        priorityRank: c => sourcePriorityRank(c.source),
        softEdges: graph.softEdges,
      })
    }
  }

  /** Cascade drops: plugins whose hard dependencies were dropped are dropped too. */
  private propagateDrops(
    active: Map<string, Candidate>,
    dropped: Set<string>,
    issues: ResolveIssue[],
  ): void {
    let changed = true
    while (changed) {
      changed = false
      for (const [id, c] of active) {
        if (dropped.has(id)) continue
        const deps = Object.keys(c.manifest.dependencies ?? {})
        const bad = deps.find(d => dropped.has(d))
        if (bad) {
          dropped.add(id)
          issues.push({
            code: 'E_MISSING_DEPENDENCY',
            level: 'error',
            pluginId: id,
            detail: `dependency dropped, cascade failure: ${bad}`,
          })
          changed = true
        }
      }
    }
  }
}

/** Extract the contract major version (e.g. '1' / '1.0' / '1.2' -> 1). */
function contractMajor(v: string): number {
  const head = String(v).split('.')[0] ?? '0'
  const n = Number(head)
  return Number.isNaN(n) ? 0 : n
}

function compareTuple(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}
