/**
 * Rollback strategy: on fatal failure, release already-executed hooks in
 * reverse order (onDispose -> onUnload -> onStop), each with a timeout and
 * isolated from the others.
 */

import type { PluginFactoryHooks } from '../contracts/plugin.js'
import type { PluginContext } from '../contracts/context.js'
import type { StopReason } from '../contracts/lifecycle.js'
import { callWithTimeout } from '../util/timeout.js'

export interface RollbackOptions {
  stopTimeoutMs: number
}

export interface RollbackResult {
  ok: boolean
  errors: Array<{ hook: string; message: string }>
}

/** Run hooks in reverse order (onDispose -> onUnload -> onStop), idempotently, swallowing individual hook errors. */
export async function rollbackHooks(
  hooks: PluginFactoryHooks,
  ctx: PluginContext,
  reason: StopReason,
  opts: RollbackOptions,
): Promise<RollbackResult> {
  const errors: Array<{ hook: string; message: string }> = []

  const steps: Array<{ hook: string; run: () => Promise<void> | void }> = []
  if (typeof hooks.onDispose === 'function') {
    steps.push({ hook: 'onDispose', run: () => hooks.onDispose!(ctx) })
  }
  if (typeof hooks.onUnload === 'function') {
    steps.push({ hook: 'onUnload', run: () => hooks.onUnload!(ctx) })
  }
  if (typeof hooks.onStop === 'function') {
    steps.push({ hook: 'onStop', run: () => hooks.onStop!(ctx, reason) })
  }

  for (const step of steps) {
    try {
      await callWithTimeout(
        step.run,
        opts.stopTimeoutMs,
        `rollback of ${step.hook} for ${ctx.pluginId}`,
      )
    } catch (error) {
      errors.push({ hook: step.hook, message: (error as Error).message })
    }
  }

  return { ok: errors.length === 0, errors }
}
