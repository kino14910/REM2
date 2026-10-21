/**
 * Physical execution pipeline: maps the logical state machine onto the
 * physical call order.
 *
 * Actual kernel action order (dependency resolution runs 2nd physically,
 * even though it is 5th in the logical order):
 *
 * ```
 * A discover() scan of the root directory
 * B read + validate plugin.json          -> Registered[]
 * C DependencyResolver.resolve(all)      (manifests must exist to know the dependency graph)
 * D per plugin in topological order: permission check -> resolveEntry ->
 *   import() -> factory call -> build container -> Resolved/Loaded
 * E onDiscover -> onLoad                 -> Initialized
 * F onConfigure (reads config snapshot)  -> Configured
 * G onStart                              -> Active / Degraded
 * H health summary + KernelReady
 * I unload: dependents first -> onStop -> onUnload -> onDispose -> force reclaim
 * ```
 *
 * This file expresses that order as data (steps plus the state transitions
 * they trigger), so `manager.ts` can drive it uniformly and tests can assert
 * "order == contract" directly.
 */

import type { LifecyclePhase } from '../contracts/lifecycle.js'
import type { PluginHookName } from '../contracts/plugin.js'
import type { PluginStateT } from '../contracts/plugins.js'

export interface PipelineStep {
  /** Logical phase (drives `ctx.phase` and the state machine). */
  phase: LifecyclePhase
  /** Physical action: the plugin hook invoked; `null` means a pure kernel action (no plugin code). */
  hook: PluginHookName | null
  to: PluginStateT
  /** States allowed before this step; `'*'` means any (the first stop step accepts any state). */
  from: readonly PluginStateT[] | '*'
  fatal: boolean
  timeoutKind: 'none' | 'start' | 'stop'
}

/** Start pipeline (steps A-G). */
export const START_PIPELINE: ReadonlyArray<PipelineStep> = [
  // B: register (discover + validate) - pure kernel action; plugin code is not imported yet.
  {
    phase: 'Registered',
    hook: null,
    from: ['Registered'],
    to: 'Registered',
    fatal: false,
    timeoutKind: 'none',
  },
  // C: dependency resolution (batch computation in the kernel) -> Resolved / Dropped.
  {
    phase: 'Resolved',
    hook: null,
    from: ['Registered'],
    to: 'Resolved',
    fatal: false,
    timeoutKind: 'none',
  },
  // D: import() + factory call + build container -> Loaded.
  {
    phase: 'Loaded',
    hook: null,
    from: ['Resolved'],
    to: 'Loaded',
    fatal: true,
    timeoutKind: 'none',
  },
  // E: onDiscover (read-only probe) -> stays Registered.
  {
    phase: 'Registered',
    hook: 'onDiscover',
    from: ['Loaded'],
    to: 'Loaded',
    fatal: false,
    timeoutKind: 'none',
  },
  // E: onLoad (prepare in-memory state) -> Initialized.
  {
    phase: 'Loaded',
    hook: 'onLoad',
    from: ['Loaded'],
    to: 'Initialized',
    fatal: true,
    timeoutKind: 'none',
  },
  // F: onConfigure (read config snapshot) -> Configured.
  {
    phase: 'Initialized',
    hook: 'onConfigure',
    from: ['Initialized'],
    to: 'Configured',
    fatal: true,
    timeoutKind: 'none',
  },
  // G: onStart -> Active (non-fatal failure or missing soft dependency -> Degraded).
  {
    phase: 'Configured',
    hook: 'onStart',
    from: ['Configured'],
    to: 'Active',
    fatal: true,
    timeoutKind: 'start',
  },
]

/** Stop pipeline (step I): reverse order, idempotent. */
export const STOP_PIPELINE: ReadonlyArray<PipelineStep> = [
  {
    phase: 'Stopped',
    hook: 'onStop',
    from: '*',
    to: 'Stopped',
    fatal: false,
    timeoutKind: 'stop',
  },
  {
    phase: 'Unloaded',
    hook: 'onUnload',
    from: ['Stopped'],
    to: 'Unloaded',
    fatal: false,
    timeoutKind: 'stop',
  },
  {
    phase: 'Disposed',
    hook: 'onDispose',
    from: ['Unloaded'],
    to: 'Disposed',
    fatal: false,
    timeoutKind: 'stop',
  },
]

/** Steps before plugin code is imported for the first time (asserts dependency resolution runs earlier). */
export const PRE_IMPORT_STEPS: readonly PipelineStep[] = START_PIPELINE.filter(
  s => s.hook === null,
)
