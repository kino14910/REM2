/**
 * Deterministic topological sort.
 *
 * Algorithm: Kahn's algorithm with a three-level total-order sort key, guaranteeing that for the
 * same node set and any input order the output `loadOrder` is identical element by element.
 *
 * Sort keys (ascending = dequeued first):
 * 1) priorityRank ascending: builtin(0) < workspace(1) < user(2)
 * 2) pluginId lexicographic ascending (localeCompare 'en')
 * 3) version descending (same id with multiple versions)
 */

import type { Candidate } from '../discovery/candidate.js'
import { compareVersions } from '../semver/semver.js'

export interface TopoSortOptions {
  /** Compute a candidate's priority rank (lower ranks come first). */
  priorityRank: (c: Candidate) => number
  /** Soft-dependency ordering optimization: pluginId -> its soft dependency ids (the soft dependency is dequeued before its dependent when present). */
  softEdges?: Map<string, string[]>
}

/** Candidate comparator (total order). */
function compareCandidates(
  a: Candidate,
  b: Candidate,
  rank: (c: Candidate) => number,
): number {
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra - rb

  const idCmp = a.manifest.id.localeCompare(b.manifest.id, 'en')
  if (idCmp !== 0) return idCmp

  // For the same id, order by version descending (the higher version is dequeued first).
  try {
    return -compareVersions(a.manifest.version, b.manifest.version)
  } catch {
    return 0
  }
}

/**
 * Compute a deterministic load order.
 *
 * @param nodes      Candidates to sort (id -> Candidate)
 * @param hardEdges  pluginId -> its hard dependency ids (dependencies come before dependents)
 * @param opts       Sort options
 * @returns Ordered pluginId list
 * @throws If a cycle exists (callers should run cycle detection first)
 */
export function topoSortedLoadOrder(
  nodes: Map<string, Candidate>,
  hardEdges: Map<string, string[]>,
  opts: TopoSortOptions,
): string[] {
  const ids = Array.from(nodes.keys())
  const idSet = new Set(ids)

  // In-degree = the number of the node's hard dependencies that exist in the graph.
  const indegree = new Map<string, number>()
  // Reverse edges: dep -> nodes that depend on it.
  const dependents = new Map<string, string[]>()

  for (const id of ids) {
    indegree.set(id, 0)
    dependents.set(id, [])
  }

  for (const id of ids) {
    const deps = (hardEdges.get(id) ?? []).filter(d => idSet.has(d))
    indegree.set(id, deps.length)
    for (const d of deps) {
      dependents.get(d)!.push(id)
    }
  }

  // Ready set: a "take the minimum key" strategy simulates a priority queue, ensuring determinism.
  const ready: string[] = ids.filter(id => (indegree.get(id) ?? 0) === 0)
  const order: string[] = []

  const rank = opts.priorityRank
  const soft = opts.softEdges

  const pickMin = (): string => {
    // Sort by the base total order first (Array.prototype.sort is unstable for equal values, so the comparator must be a total order).
    ready.sort((x, y) => {
      const cx = nodes.get(x)!
      const cy = nodes.get(y)!

      // Soft-dependency priority: if y soft-depends on x, x should be dequeued earlier.
      const xBeforeY = (soft?.get(y) ?? []).includes(x)
      const yBeforeX = (soft?.get(x) ?? []).includes(y)
      if (xBeforeY && !yBeforeX) return -1
      if (yBeforeX && !xBeforeY) return 1

      return compareCandidates(cx, cy, rank)
    })
    return ready.shift()!
  }

  while (ready.length > 0) {
    const id = pickMin()
    order.push(id)
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, next)
      if (next === 0) {
        ready.push(dependent)
      }
    }
  }

  if (order.length !== ids.length) {
    const remaining = ids.filter(id => !order.includes(id))
    throw new Error(
      `topological sort failed: circular dependency detected, involving nodes: ${remaining.join(', ')}`,
    )
  }

  return order
}
