/**
 * 生命周期阶段定义与合法跃迁表（docs/02 §C.1）。
 */

import type { LifecyclePhase } from '../contracts/lifecycle.js';

/** 生命周期阶段的声明式定义（有序）。 */
export interface PhaseDef {
  phase: LifecyclePhase;
  /** 对应钩子名。 */
  hook: string;
  /** 该阶段失败是否视为致命（致命 → Failed，否则 → Degraded）。 */
  fatal: boolean;
  /** 该阶段的超时来源。 */
  timeoutKind: 'none' | 'start' | 'stop';
}

/** 7 阶段有序表。 */
export const PHASES: ReadonlyArray<PhaseDef> = [
  { phase: 'Discover', hook: 'onDiscover', fatal: false, timeoutKind: 'none' },
  { phase: 'Load', hook: 'onLoad', fatal: true, timeoutKind: 'none' },
  {
    phase: 'Initialize',
    hook: 'onConfigure',
    fatal: true,
    timeoutKind: 'none',
  },
  { phase: 'Start', hook: 'onStart', fatal: true, timeoutKind: 'start' },
  { phase: 'Stop', hook: 'onStop', fatal: false, timeoutKind: 'stop' },
  { phase: 'Unload', hook: 'onUnload', fatal: false, timeoutKind: 'stop' },
  { phase: 'Dispose', hook: 'onDispose', fatal: false, timeoutKind: 'stop' },
];

/** 起始阶段集合。 */
export const START_PHASES: ReadonlyArray<LifecyclePhase> = [
  'Discover',
  'Load',
  'Initialize',
  'Start',
];
/** 停止阶段集合。 */
export const STOP_PHASES: ReadonlyArray<LifecyclePhase> = [
  'Stop',
  'Unload',
  'Dispose',
];

/** 阶段在序列中的序号（-1 表示 Degraded 等非阶段态）。 */
export function phaseIndex(phase: LifecyclePhase): number {
  return PHASES.findIndex((p) => p.phase === phase);
}

/**
 * 判断跃迁是否合法。
 *
 * 允许：
 * - 顺序前进（相邻或跳过可选钩子，但不得回退，Stop 之前不得出现 Stop/Unload/Dispose）。
 * - 任意阶段 → Stop/Unload/Dispose（失败回滚路径）。
 * - 任意阶段 → Degraded。
 */
export function isLegalTransition(
  from: LifecyclePhase,
  to: LifecyclePhase,
): boolean {
  if (to === 'Degraded') return true;
  if (phaseIndex(to) <= phaseIndex(from)) return false;
  // 不能从停止序列回到启动序列（由 phaseIndex 已保证）。
  if (to === 'Discover' || to === 'Load') {
    return from === 'Discover' || from === 'Load';
  }
  return true;
}
