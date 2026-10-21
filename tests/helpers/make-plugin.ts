import { defineToken } from 'rem2-kernel'
import type {
  HealthStatus,
  PluginContext,
  PluginFactoryHooks,
  ServiceToken,
  StopReason,
} from 'rem2-kernel'
import { makeManifest, type MakeManifestOptions } from './make-manifest.js'

/** Hook invocation record. */
export interface HookLog {
  hook: string
  phase: string
  reason?: StopReason
}

/** makePlugin options. */
export interface MakePluginOptions extends MakeManifestOptions {
  /** onStart behavior: normal / throw / hang (triggers timeout). */
  startBehavior?: 'ok' | 'throw' | { throw: string } | { delayMs: number }
  /** onConfigure behavior. */
  configureBehavior?: 'ok' | { throw: string }
  /** Health status. */
  health?: HealthStatus
  /** Custom onStart callback (overrides the behaviors above). */
  onStart?: (ctx: PluginContext) => void | Promise<void>
  /** Shared hook log array. */
  log?: HookLog[]
}

/** Convenience: create a service token named id. */
export function tokenFor<T>(id: string): ServiceToken<T> {
  return defineToken<T>({ id, describe: id })
}

/**
 * Create a plugin's hook set in memory.
 *
 * Note: in the factory form the manifest comes from `plugin.json`, and the
 * inline manifest is only used for auxiliary assertions, so this returns
 * `PluginFactoryHooks` (no manifest field).
 */
export function makePlugin(opts: MakePluginOptions): PluginFactoryHooks {
  const manifest = makeManifest(opts)
  const hookLog = opts.log ?? []

  const record = (hook: string, phase: string, reason?: StopReason): void => {
    hookLog.push(reason ? { hook, phase, reason } : { hook, phase })
  }

  return {
    async onDiscover(): Promise<void> {
      record('onDiscover', 'Registered')
    },

    async onLoad(): Promise<void> {
      record('onLoad', 'Loaded')
    },

    async onConfigure(): Promise<void> {
      record('onConfigure', 'Initialized')
      if (opts.configureBehavior && opts.configureBehavior !== 'ok') {
        throw new Error(opts.configureBehavior.throw)
      }
    },

    async onStart(ctx: PluginContext): Promise<void> {
      record('onStart', 'Configured')
      if (opts.onStart) {
        await opts.onStart(ctx)
        return
      }
      const behavior = opts.startBehavior ?? 'ok'
      if (behavior === 'throw') {
        throw new Error(`${manifest.id} failed to start`)
      }
      if (typeof behavior === 'object' && 'throw' in behavior) {
        throw new Error(behavior.throw)
      }
      if (typeof behavior === 'object' && 'delayMs' in behavior) {
        await new Promise(resolve => setTimeout(resolve, behavior.delayMs))
      }
    },

    async onStop(_ctx: PluginContext, reason: StopReason): Promise<void> {
      record('onStop', 'Stopped', reason)
    },

    async onUnload(): Promise<void> {
      record('onUnload', 'Unloaded')
    },

    async onDispose(): Promise<void> {
      record('onDispose', 'Disposed')
    },

    onHealthCheck(): HealthStatus {
      return opts.health ?? 'healthy'
    },
  }
}
