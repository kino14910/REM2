/**
 * Lifecycle manager: drives plugin hooks in physical execution order, with
 * timeouts and rollback; errors are isolated (never thrown to the kernel).
 *
 * It drives the `START_PIPELINE` / `STOP_PIPELINE` from `pipeline.ts` rather
 * than "calling the 7 hooks in sequence" - the difference is the state
 * transition points: e.g. `onLoad` must succeed to enter `Initialized`,
 * `onStart` to enter `Active`.
 */

import type { LifecyclePhase, StopReason } from '../contracts/lifecycle.js'
import type { PluginFactoryHooks } from '../contracts/plugin.js'
import type { PluginStateT } from '../contracts/plugins.js'
import type { PluginContext } from '../contracts/context.js'
import type { PhaseOutcome } from '../contracts/lifecycle.js'
import { START_PIPELINE, STOP_PIPELINE, type PipelineStep } from './pipeline.js'
import { rollbackHooks } from './rollback.js'
import { callWithTimeout } from '../util/timeout.js'

export interface LifecycleState {
  pluginId: string
  phase: LifecyclePhase
  state: PluginStateT
  startedAt: number
  rolledBack: boolean
}

export interface LifecycleOutcome {
  ok: boolean
  degraded: boolean
  phaseResults: PhaseOutcome[]
  error?: string
  rolledBack: boolean
  /** State after the pipeline completes successfully (`Active` or `Degraded`). */
  finalState: PluginStateT
}

export interface LifecycleManagerOptions {
  startTimeoutMs: number
  stopTimeoutMs: number
  /** Observability callback after a phase runs (for metrics). */
  onPhase?: (
    pluginId: string,
    phase: LifecyclePhase,
    durationMs: number,
    ok: boolean,
  ) => void
}

export class LifecycleManager {
  private readonly states = new Map<string, LifecycleState>()

  constructor(private readonly opts: LifecycleManagerOptions) {}

  getState(pluginId: string): LifecycleState | undefined {
    return this.states.get(pluginId)
  }

  allStates(): LifecycleState[] {
    return Array.from(this.states.values())
  }

  /**
   * Run the start pipeline.
   *
   * Any fatal step failure rolls back the executed hooks in reverse order and
   * returns ok=false (the kernel then marks the plugin Failed). A non-fatal
   * step failure lets the sequence continue and ends as Degraded. Missing
   * soft dependencies also mark it Degraded (passed via `missingOptional`).
   */
  async runStartSequence(
    hooks: PluginFactoryHooks,
    ctx: PluginContext,
    missingOptional: string[] = [],
  ): Promise<LifecycleOutcome> {
    const pluginId = ctx.pluginId
    const phaseResults: PhaseOutcome[] = []
    const startedAt = Date.now()
    let hasNonFatalFailure = false
    this.states.set(pluginId, {
      pluginId,
      phase: 'Registered',
      state: 'Loaded',
      startedAt,
      rolledBack: false,
    })

    for (const step of START_PIPELINE) {
      // pure kernel steps (register / dependency resolution / load) are owned by the kernel; here we only advance state
      if (step.hook === null) {
        this.states.set(pluginId, {
          pluginId,
          phase: step.phase,
          state: step.to,
          startedAt,
          rolledBack: false,
        })
        continue
      }

      const result = await this.runStep(hooks, ctx, step)
      phaseResults.push(result)

      if (result.ok) {
        this.states.set(pluginId, {
          pluginId,
          phase: step.phase,
          state: step.to,
          startedAt,
          rolledBack: false,
        })
        continue
      }

      if (step.fatal) {
        await rollbackHooks(hooks, ctx, 'start-failed', {
          stopTimeoutMs: this.opts.stopTimeoutMs,
        })
        this.states.set(pluginId, {
          pluginId,
          phase: step.phase,
          state: 'Failed',
          startedAt,
          rolledBack: true,
        })
        return {
          ok: false,
          degraded: false,
          phaseResults,
          ...(result.error !== undefined ? { error: result.error } : {}),
          rolledBack: true,
          finalState: 'Failed',
        }
      }

      hasNonFatalFailure = true
    }

    const degraded = hasNonFatalFailure || missingOptional.length > 0
    return {
      ok: true,
      degraded,
      phaseResults,
      rolledBack: false,
      finalState: degraded ? 'Degraded' : 'Active',
    }
  }

  /** Run the stop pipeline (idempotent; a single hook failure does not block the rest). */
  async runStopSequence(
    hooks: PluginFactoryHooks,
    ctx: PluginContext,
    reason: StopReason,
  ): Promise<{ ok: boolean; phaseResults: PhaseOutcome[] }> {
    const pluginId = ctx.pluginId
    const phaseResults: PhaseOutcome[] = []
    const startedAt = this.states.get(pluginId)?.startedAt ?? Date.now()

    for (const step of STOP_PIPELINE) {
      phaseResults.push(await this.runStep(hooks, ctx, step, reason))
      this.states.set(pluginId, {
        pluginId,
        phase: step.phase,
        state: step.to,
        startedAt,
        rolledBack: this.states.get(pluginId)?.rolledBack ?? false,
      })
    }

    return { ok: phaseResults.every(r => r.ok), phaseResults }
  }

  private async runStep(
    hooks: PluginFactoryHooks,
    ctx: PluginContext,
    step: PipelineStep,
    stopReason: StopReason = 'user-disable',
  ): Promise<PhaseOutcome> {
    const started = Date.now()
    const hookName = step.hook
    if (hookName === null) {
      return {
        pluginId: ctx.pluginId,
        phase: step.phase,
        ok: true,
        durationMs: 0,
      }
    }

    const hook = hooks[hookName] as
      | ((c: PluginContext, r?: StopReason) => unknown)
      | undefined

    if (typeof hook !== 'function') {
      // hooks are optional: skipping counts as success
      const durationMs = Date.now() - started
      this.opts.onPhase?.(ctx.pluginId, step.phase, durationMs, true)
      return { pluginId: ctx.pluginId, phase: step.phase, ok: true, durationMs }
    }

    const timeoutMs =
      step.timeoutKind === 'start'
        ? this.opts.startTimeoutMs
        : step.timeoutKind === 'stop'
          ? this.opts.stopTimeoutMs
          : 0

    try {
      // Hooks must be called with `hooks` as the receiver: a hook may be a
      // closure (the return value of a normal plugin's setup) or a class
      // instance (WorkerPluginProxy sends RPC via this.host). Calling without
      // a receiver leaves `this === undefined` for the latter, causing
      // "Cannot read properties of undefined (reading 'host')", which only
      // shows up on worker plugins.
      const fn =
        hookName === 'onStop'
          ? () =>
              (
                hook as (
                  this: unknown,
                  c: PluginContext,
                  r: StopReason,
                ) => unknown
              ).call(hooks, ctx, stopReason)
          : hookName === 'onHealthCheck'
            ? () => (hook as (this: unknown) => unknown).call(hooks)
            : () =>
                (hook as (this: unknown, c: PluginContext) => unknown).call(
                  hooks,
                  ctx,
                )
      await callWithTimeout(fn, timeoutMs, `${ctx.pluginId} ${step.phase}`)
      const durationMs = Date.now() - started
      this.opts.onPhase?.(ctx.pluginId, step.phase, durationMs, true)
      return { pluginId: ctx.pluginId, phase: step.phase, ok: true, durationMs }
    } catch (error) {
      const durationMs = Date.now() - started
      this.opts.onPhase?.(ctx.pluginId, step.phase, durationMs, false)
      return {
        pluginId: ctx.pluginId,
        phase: step.phase,
        ok: false,
        durationMs,
        error: (error as Error).message,
      }
    }
  }
}
