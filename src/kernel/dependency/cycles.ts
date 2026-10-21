/**
 * Cycle detection (DFS three-color marking).
 *
 * white = unvisited / gray = on stack / black = finished; encountering a gray node reveals a cycle, and backtracking the stack yields the cycle path.
 */

const WHITE = 0
const GRAY = 1
const BLACK = 2

/**
 * Find all cycles in the graph.
 *
 * @param graph pluginId -> dependency id list (edge direction: node -> its dependencies)
 * @returns Cycle paths, each closed like `['a','b','c','a']` (first and last node match)
 */
export function findCycles(graph: Map<string, string[]>): string[][] {
  const color = new Map<string, number>()
  const stack: string[] = []
  const cycles: string[][] = []
  const seenCycleKeys = new Set<string>()

  // Collect all nodes (including nodes that only appear as dependencies).
  const allNodes = new Set<string>()
  for (const [node, deps] of graph) {
    allNodes.add(node)
    for (const d of deps) allNodes.add(d)
  }
  for (const n of allNodes) color.set(n, WHITE)

  const dfs = (node: string): void => {
    color.set(node, GRAY)
    stack.push(node)

    for (const dep of graph.get(node) ?? []) {
      const c = color.get(dep) ?? WHITE
      if (c === WHITE) {
        dfs(dep)
      } else if (c === GRAY) {
        // Cycle found: slice the stack from dep's position up to the current node, then close the loop.
        const start = stack.indexOf(dep)
        if (start !== -1) {
          const cycle = stack.slice(start).concat(dep)
          const key = canonicalCycleKey(cycle)
          if (!seenCycleKeys.has(key)) {
            seenCycleKeys.add(key)
            cycles.push(cycle)
          }
        }
      }
    }

    stack.pop()
    color.set(node, BLACK)
  }

  // Traverse in name order to keep cycle detection results deterministic.
  const sortedNodes = Array.from(allNodes).sort((a, b) =>
    a.localeCompare(b, 'en'),
  )
  for (const node of sortedNodes) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      dfs(node)
    }
  }

  return cycles
}

/** Build a rotation-independent canonical key (dedupes different rotations of the same cycle). */
function canonicalCycleKey(cycle: string[]): string {
  const body = cycle.slice(0, -1)
  if (body.length === 0) return ''
  let minIdx = 0
  for (let i = 1; i < body.length; i += 1) {
    if (body[i]!.localeCompare(body[minIdx]!, 'en') < 0) minIdx = i
  }
  const rotated = body.slice(minIdx).concat(body.slice(0, minIdx))
  return rotated.join('>')
}

export function hasCycle(graph: Map<string, string[]>): boolean {
  return findCycles(graph).length > 0
}

/** Collect the set of all nodes on cycles (for the "drop every plugin on a cycle" policy). */
export function cycleNodes(cycles: string[][]): Set<string> {
  const set = new Set<string>()
  for (const cycle of cycles) {
    for (const node of cycle) set.add(node)
  }
  return set
}
