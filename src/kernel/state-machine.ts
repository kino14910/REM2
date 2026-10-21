/**
 * Logical state machine: the transition table of lifecycle phases plus
 * terminal states.
 *
 * "Logical" refers to externally observable state transitions (the stages a
 * plugin passes through from discovery to being useful); the order in which
 * the kernel actually calls code is the physical pipeline, see
 * `lifecycle/pipeline.ts`.
 *
 * Key trade-off: dependency resolution is step 5 in the logical order
 * (`Registered -> Resolved`) but step 2 in the physical order, because the
 * dependency graph is only known once manifests have been read. The two
 * orders do not conflict: the state machine describes the plugin's lifecycle,
 * the physical pipeline describes the kernel's actions.
 */

import type { PluginStateT } from './contracts/plugins.js'

/** State transition table: legal successors of `from`. */
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
}

/** Whether a state transition is legal. */
export function canTransition(from: PluginStateT, to: PluginStateT): boolean {
  return TRANSITIONS[from].includes(to)
}

/** Ordinal of a state within `PLUGIN_STATES` (-1 if not listed). */
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
  ]
  return ALL.indexOf(state)
}

/** State -> lifecycle phase (the value of `ctx.phase`); compile-time exhaustive. */
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
} as const satisfies Record<PluginStateT, string>

/** Kernel start result (asserted by the CLI and tests). */
export interface KernelStartResult {
  /** Topological load order (dropped plugins excluded). */
  loadOrder: string[]
  started: string[]
  degraded: string[]
  failed: string[]
  /** Ids of plugins dropped by the resolver (missing hard dependency / version mismatch / cycle / incompatibility). */
  dropped: string[]
}
