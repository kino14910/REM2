/**
 * Lifecycle phase definitions (7 phases in physical execution order).
 *
 * Phase names align with the `LifecyclePhase` state machine; `hook` is the
 * plugin hook actually invoked during physical execution. Transition
 * legality lives in `state-machine.ts`; this file only maps phases to hooks.
 */

import type { LifecyclePhase } from '../contracts/lifecycle.js'
import type { PluginHookName } from '../contracts/plugin.js'
import type { PluginStateT } from '../contracts/plugins.js'

/** Declarative definition of a lifecycle phase (order = physical execution order). */
export interface PhaseDef {
  phase: LifecyclePhase
  hook: PluginHookName
  nextState: PluginStateT
  /** Whether failure in this phase is fatal (fatal -> Failed, otherwise -> Degraded). */
  fatal: boolean
  timeoutKind: 'none' | 'start' | 'stop'
}

/** Ordered table of the 7 phases (start: Discover -> Load -> Configure -> Start; stop: Stop -> Unload -> Dispose). */
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
]

export const START_PHASES: ReadonlyArray<LifecyclePhase> = [
  'Registered',
  'Loaded',
  'Initialized',
  'Configured',
]

export const STOP_PHASES: ReadonlyArray<LifecyclePhase> = [
  'Stopped',
  'Unloaded',
  'Disposed',
]

/** Index of a phase in the sequence (-1 means not part of the ordered set). */
export function phaseIndex(phase: LifecyclePhase): number {
  return PHASES.findIndex(p => p.phase === phase)
}

export function phaseDef(phase: LifecyclePhase): PhaseDef | undefined {
  return PHASES.find(p => p.phase === phase)
}

/**
 * Whether a phase transition is legal (forward-only, any phase may enter the
 * stop sequence, Degraded is always reachable).
 *
 * This constrains only the hook call order; state transition legality is
 * decided by `state-machine.canTransition`.
 */
export function isLegalTransition(
  from: LifecyclePhase,
  to: LifecyclePhase,
): boolean {
  if (to === 'Degraded') return true
  const fromIdx = phaseIndex(from)
  const toIdx = phaseIndex(to)
  if (toIdx < 0) return false
  if (from === 'Degraded') return toIdx >= phaseIndex('Stopped')
  if (fromIdx < 0) return toIdx >= 0
  // no regression back to the start sequence before the stop sequence
  const stopStart = phaseIndex('Stopped')
  if (toIdx >= stopStart) return true
  return toIdx > fromIdx
}
