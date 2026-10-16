/**
 * 逻辑状态机（docs/03 §4.2）：7 段 + 终态的转移表。
 *
 * 「逻辑」指**对外可观测**的状态跃迁（一个插件从被发现到能干活经历了哪些阶段）；
 * 内核实际调用代码的顺序是「物理执行管线」，见 `lifecycle/pipeline.ts`。
 *
 * 关键取舍（docs/03 §4.1）：依赖解析在**逻辑序里排第 5**（`Registered → Resolved`），
 * 在**物理序里排第 2**（必须先读 manifest 才知道依赖图）。两者不矛盾：
 * 状态机描述插件的认知，物理管线描述内核的动作。
 */

import type { PluginStateT } from './contracts/plugins.js';

/** 状态转移表：`from` 的合法后继。 */
export const TRANSITIONS: Readonly<
  Record<PluginStateT, readonly PluginStateT[]>
> = {
  Registered: ['Resolved', 'Dropped', 'Failed'],
  Resolved: ['Loaded', 'Failed', 'Dropped'],
  Dropped: [],
  Loaded: ['Initialized', 'Failed', 'Stopped'],
  Initialized: ['Configured', 'Failed', 'Stopped'],
  Configured: ['Active', 'Degraded', 'Failed', 'Stopped'],
  Active: ['Stopped', 'Degraded'],
  Degraded: ['Stopped', 'Active'],
  Failed: ['Stopped', 'Disposed'],
  Stopped: ['Unloaded', 'Disposed'],
  Unloaded: ['Disposed'],
  Disposed: [],
};

/** 判断一次状态跃迁是否合法。 */
export function canTransition(from: PluginStateT, to: PluginStateT): boolean {
  return TRANSITIONS[from].includes(to);
}

/** 状态在 `PLUGIN_STATES` 中的序号（未收录 → -1）。 */
export function stateOrdinal(state: PluginStateT): number {
  const ALL: readonly PluginStateT[] = [
    'Registered',
    'Resolved',
    'Dropped',
    'Loaded',
    'Initialized',
    'Configured',
    'Active',
    'Degraded',
    'Failed',
    'Stopped',
    'Unloaded',
    'Disposed',
  ];
  return ALL.indexOf(state);
}

/** 状态 → 生命周期阶段（`ctx.phase` 的取值）。编译期穷尽。 */
export const PHASE_OF_STATE = {
  Registered: 'Registered',
  Resolved: 'Resolved',
  Dropped: 'Registered',
  Loaded: 'Loaded',
  Initialized: 'Initialized',
  Configured: 'Configured',
  Active: 'Active',
  Degraded: 'Degraded',
  Failed: 'Degraded',
  Stopped: 'Stopped',
  Unloaded: 'Unloaded',
  Disposed: 'Disposed',
} as const satisfies Record<PluginStateT, string>;

/** 内核启动结果（供 CLI / 测试断言）。 */
export interface KernelStartResult {
  /** 拓扑加载序（已剔除被丢弃的插件）。 */
  loadOrder: string[];
  started: string[];
  degraded: string[];
  failed: string[];
  /** 被解析器丢弃的插件 id（硬依赖缺失 / 版本不符 / 成环 / 不兼容）。 */
  dropped: string[];
}
