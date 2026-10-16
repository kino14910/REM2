/**
 * 生命周期阶段定义（docs/03 §4.3 的 7 段 + 物理执行序）。
 *
 * 阶段名与 `LifecyclePhase` 对齐状态机；`hook` 是物理执行时实际调用的插件钩子。
 * 状态跃迁的合法性在 `state-machine.ts`，本文件只管「哪个阶段调哪个钩子」。
 */

import type { LifecyclePhase } from '../contracts/lifecycle.js';
import type { PluginHookName } from '../contracts/plugin.js';
import type { PluginStateT } from '../contracts/plugins.js';

/** 生命周期阶段的声明式定义（有序 = 物理执行序）。 */
export interface PhaseDef {
  phase: LifecyclePhase;
  /** 对应钩子名。 */
  hook: PluginHookName;
  /** 该阶段完成后插件进入的状态。 */
  nextState: PluginStateT;
  /** 该阶段失败是否视为致命（致命 → Failed，否则 → Degraded）。 */
  fatal: boolean;
  /** 该阶段的超时来源。 */
  timeoutKind: 'none' | 'start' | 'stop';
}

/** 7 段有序表（启动序列 Discover → Load → Configure → Start，停止序列 Stop → Unload → Dispose）。 */
export const PHASES: ReadonlyArray<PhaseDef> = [
  {
    phase: 'Registered',
    hook: 'onDiscover',
    nextState: 'Registered',
    fatal: false,
    timeoutKind: 'none',
  },
  {
    phase: 'Loaded',
    hook: 'onLoad',
    nextState: 'Initialized',
    fatal: true,
    timeoutKind: 'none',
  },
  {
    phase: 'Initialized',
    hook: 'onConfigure',
    nextState: 'Configured',
    fatal: true,
    timeoutKind: 'none',
  },
  {
    phase: 'Configured',
    hook: 'onStart',
    nextState: 'Active',
    fatal: true,
    timeoutKind: 'start',
  },
  {
    phase: 'Stopped',
    hook: 'onStop',
    nextState: 'Stopped',
    fatal: false,
    timeoutKind: 'stop',
  },
  {
    phase: 'Unloaded',
    hook: 'onUnload',
    nextState: 'Unloaded',
    fatal: false,
    timeoutKind: 'stop',
  },
  {
    phase: 'Disposed',
    hook: 'onDispose',
    nextState: 'Disposed',
    fatal: false,
    timeoutKind: 'stop',
  },
];

/** 启动序列的阶段集合。 */
export const START_PHASES: ReadonlyArray<LifecyclePhase> = [
  'Registered',
  'Loaded',
  'Initialized',
  'Configured',
];

/** 停止序列的阶段集合。 */
export const STOP_PHASES: ReadonlyArray<LifecyclePhase> = [
  'Stopped',
  'Unloaded',
  'Disposed',
];

/** 阶段在序列中的序号（-1 表示不属于有序阶段集合）。 */
export function phaseIndex(phase: LifecyclePhase): number {
  return PHASES.findIndex((p) => p.phase === phase);
}

/** 按阶段名取定义。 */
export function phaseDef(phase: LifecyclePhase): PhaseDef | undefined {
  return PHASES.find((p) => p.phase === phase);
}

/**
 * 阶段跃迁是否合法（顺序前进 + 任意阶段可进入停止序列 + 可进入 Degraded）。
 *
 * 注意这只约束**钩子调用序**；状态跃迁的合法性由 `state-machine.canTransition` 判定。
 */
export function isLegalTransition(
  from: LifecyclePhase,
  to: LifecyclePhase,
): boolean {
  if (to === 'Degraded') return true;
  const fromIdx = phaseIndex(from);
  const toIdx = phaseIndex(to);
  if (toIdx < 0) return false;
  if (from === 'Degraded') return toIdx >= phaseIndex('Stopped');
  if (fromIdx < 0) return toIdx >= 0;
  // 停止序列之前不得回退到启动序列。
  const stopStart = phaseIndex('Stopped');
  if (toIdx >= stopStart) return true;
  return toIdx > fromIdx;
}
