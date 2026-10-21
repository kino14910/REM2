/**
 * Dependency graph construction.
 *
 * Takes a candidate set and outputs:
 * - Hard dependency edges (participate in topological constraints)
 * - Soft dependency edges (do not participate in topological constraints; used only for soft ordering optimization)
 */

import type { Candidate } from '../discovery/candidate.js'

export interface DependencyGraph {
  /** pluginId -> its hard dependency id list (deduped, insertion order preserved). */
  hardEdges: Map<string, string[]>
  /** pluginId -> its soft dependency id list. */
  softEdges: Map<string, string[]>
  /** pluginId -> candidate (ids referenced only by soft dependencies but absent from the candidate set do not appear here). */
  nodes: Map<string, Candidate>
}

/**
 * Build the dependency graph.
 *
 * Hard dependency edges only include dependencies that actually exist in the candidate set; missing dependencies are reported as issues by the resolver.
 *
 * @param candidates Candidate plugin set (duplicate ids are deduped by the resolver before being passed in)
 */
export function buildGraph(candidates: Candidate[]): DependencyGraph {
  const nodes = new Map<string, Candidate>()
  const hardEdges = new Map<string, string[]>()
  const softEdges = new Map<string, string[]>()

  const ids = new Set(candidates.map(c => c.manifest.id))

  for (const c of candidates) {
    const id = c.manifest.id
    nodes.set(id, c)

    const hard: string[] = []
    const deps = c.manifest.dependencies ?? {}
    for (const dep of Object.keys(deps)) {
      if (ids.has(dep) && dep !== id) {
        hard.push(dep)
      }
    }
    hardEdges.set(id, dedupe(hard))

    const soft: string[] = []
    const opts = c.manifest.optionalDependencies ?? {}
    for (const dep of Object.keys(opts)) {
      if (ids.has(dep) && dep !== id) {
        soft.push(dep)
      }
    }
    softEdges.set(id, dedupe(soft))
  }

  return { hardEdges, softEdges, nodes }
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr))
}

/**
 * Build a merged graph that includes soft edges, used only for cycle detection (soft edges can be broken automatically).
 */
export function mergeEdges(graph: DependencyGraph): Map<string, string[]> {
  const merged = new Map<string, string[]>()
  for (const [id, hard] of graph.hardEdges) {
    const soft = graph.softEdges.get(id) ?? []
    merged.set(id, dedupe([...hard, ...soft]))
  }
  return merged
}
