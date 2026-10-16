/**
 * 循环依赖检测（DFS 三色标记，见 docs/01）。
 *
 * 白=未访问 / 灰=在栈 / 黑=已完成；遇见灰节点即发现环，回溯栈得到环路径。
 */

/** 颜色枚举。 */
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

/**
 * 查找图中所有环。
 *
 * @param graph pluginId -> 依赖 id 列表（边方向：节点 → 其依赖）
 * @returns 环路径列表，每个环形如 `['a','b','c','a']`（首尾闭合）
 */
export function findCycles(graph: Map<string, string[]>): string[][] {
  const color = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seenCycleKeys = new Set<string>();

  // 收集所有节点（含只作为依赖出现的节点）。
  const allNodes = new Set<string>();
  for (const [node, deps] of graph) {
    allNodes.add(node);
    for (const d of deps) allNodes.add(d);
  }
  for (const n of allNodes) color.set(n, WHITE);

  const dfs = (node: string): void => {
    color.set(node, GRAY);
    stack.push(node);

    for (const dep of graph.get(node) ?? []) {
      const c = color.get(dep) ?? WHITE;
      if (c === WHITE) {
        dfs(dep);
      } else if (c === GRAY) {
        // 找到环：从栈中 dep 的位置截取到当前节点，再闭合。
        const start = stack.indexOf(dep);
        if (start !== -1) {
          const cycle = stack.slice(start).concat(dep);
          const key = canonicalCycleKey(cycle);
          if (!seenCycleKeys.has(key)) {
            seenCycleKeys.add(key);
            cycles.push(cycle);
          }
        }
      }
    }

    stack.pop();
    color.set(node, BLACK);
  };

  // 按名称排序遍历，保证环检测结果确定。
  const sortedNodes = Array.from(allNodes).sort((a, b) =>
    a.localeCompare(b, 'en'),
  );
  for (const node of sortedNodes) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      dfs(node);
    }
  }

  return cycles;
}

/** 生成与旋转无关的规范化 key（用于去重同一个环的不同旋转表示）。 */
function canonicalCycleKey(cycle: string[]): string {
  const body = cycle.slice(0, -1); // 去掉闭合尾节点
  if (body.length === 0) return '';
  let minIdx = 0;
  for (let i = 1; i < body.length; i += 1) {
    if (body[i]!.localeCompare(body[minIdx]!, 'en') < 0) minIdx = i;
  }
  const rotated = body.slice(minIdx).concat(body.slice(0, minIdx));
  return rotated.join('>');
}

/**
 * 判断图中是否存在环。
 */
export function hasCycle(graph: Map<string, string[]>): boolean {
  return findCycles(graph).length > 0;
}

/**
 * 找出环上所有节点集合（供"环上全部插件均不加载"策略使用）。
 */
export function cycleNodes(cycles: string[][]): Set<string> {
  const set = new Set<string>();
  for (const cycle of cycles) {
    for (const node of cycle) set.add(node);
  }
  return set;
}
