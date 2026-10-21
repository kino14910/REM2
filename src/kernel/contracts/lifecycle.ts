/**
 * Lifecycle contracts (types only).
 *
 * `ctx.phase` reflects the current position of the logical state machine,
 * not which hook the kernel is calling; `lifecycle/pipeline.ts` maps between
 * the two.
 */

/**
 * Lifecycle phases (the observable subset of the logical state machine).
 *
 * `Degraded` is not a normal phase but a degraded state: startup succeeded
 * with reduced capability.
 */
export type LifecyclePhase =
  | 'Registered'
  | 'Resolved'
  | 'Loaded'
  | 'Initialized'
  | 'Configured'
  | 'Active'
  | 'Degraded'
  | 'Stopped'
  | 'Unloaded'
  | 'Disposed'

/** Stop/failure reason; determines the rollback path. */
export type StopReason =
  | 'user-disable'
  | 'reload'
  | 'dependency-failed'
  | 'health-degraded'
  | 'shutdown'
  | 'start-failed'
  | 'timeout'

export interface PhaseOutcome {
  pluginId: string
  phase: LifecyclePhase
  ok: boolean
  durationMs: number
  error?: string
}
