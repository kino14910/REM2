/**
 * Plugin shape contracts.
 *
 * Single shape: `export default definePlugin(manifest, setup)`.
 * The loader only asserts `typeof mod.default === 'function'` and no
 * longer guesses among multiple plugin shapes.
 */

import type { PluginContext } from './context.js'
import type { HealthStatus } from './health.js'
import type { StopReason } from './lifecycle.js'

/** Plugin hooks (all optional; the kernel invokes them in physical execution order). */
export type PluginFactoryHooks = {
  /** Register/discover: read-only probing and supplemental declarations only; side effects are forbidden (no IO writes, no registrations). */
  onDiscover?(ctx: PluginContext): Promise<void> | void
  /** Load: the module is already imported; this stage only prepares in-memory state. */
  onLoad?(ctx: PluginContext): Promise<void> | void
  /** Configure: read the config snapshot, register services into the child container, subscribe to events (rollback-able). */
  onConfigure?(ctx: PluginContext): Promise<void> | void
  /** Start: bring up the runtime (open connections, start timers); must finish within startTimeoutMs. */
  onStart?(ctx: PluginContext): Promise<void> | void
  /** Stop: idempotent shutdown that releases runtime resources. */
  onStop?(ctx: PluginContext, reason: StopReason): Promise<void> | void
  /** Unload: deregister services and event subscriptions, clear in-memory state. */
  onUnload?(ctx: PluginContext): Promise<void> | void
  /** Dispose: final release; the hooks object must not be used afterwards. */
  onDispose?(ctx: PluginContext): Promise<void> | void
  /** Optional health self-check (exposed through the `health.check` extension point). */
  onHealthCheck?(): Promise<HealthStatus> | HealthStatus
}

/** Plugin factory: produced by `definePlugin`; the loader calls it after import to obtain the hooks. */
export type PluginFactory = (ctx: PluginContext) => PluginFactoryHooks

/** Hook names (keys of `PluginFactoryHooks`, for exhaustive phase-table checks). */
export type PluginHookName = keyof PluginFactoryHooks

/** All hook names, in order. */
export const PLUGIN_HOOK_NAMES = [
  'onDiscover',
  'onLoad',
  'onConfigure',
  'onStart',
  'onStop',
  'onUnload',
  'onDispose',
  'onHealthCheck',
] as const satisfies readonly PluginHookName[]

/** Default export shape of a plugin module: the single shape is the factory function. */
export type PluginModuleExport = PluginFactory | { default: PluginFactory }
