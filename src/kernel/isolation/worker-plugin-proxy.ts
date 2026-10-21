/**
 * Worker plugin proxy (kernel-side view).
 *
 * For `LifecycleManager` / `PluginsRegistry` the proxy is just an ordinary
 * `PluginFactoryHooks` object: hooks are forwarded via RPC to the real
 * plugin inside the worker thread, which uses its own simplified context
 * (see `worker-bootstrap.ts`).
 *
 * It also carries the worker-side extension point contributions (docs/01
 * §4.4): only log.sink / metrics.sink / trace.exporter, with values that
 * must be structured-cloneable. Contributions are forwarded via RPC from
 * the worker's `extensions.contribute` to the kernel's
 * `ExtensionPointRegistry`.
 */

import type { PluginFactoryHooks } from '../contracts/plugin.js'
import type { StopReason } from '../contracts/lifecycle.js'
import type { WorkerPluginHost } from './worker-host.js'
import { WORKER_ALLOWED_EXTENSION_POINTS } from './worker-protocol.js'

/** Worker-contributable extension points (shared definition used by `worker-bootstrap` and this file). */
export const WORKER_CONTRIBUTABLE_POINTS: ReadonlySet<string> = new Set(
  WORKER_ALLOWED_EXTENSION_POINTS,
)

export class WorkerPluginProxy implements PluginFactoryHooks {
  constructor(private readonly host: WorkerPluginHost) {}

  // The PluginContext in hook arguments cannot cross structured clone, so the
  // worker side builds its own proxy context; only serializable extra
  // arguments (e.g. StopReason) are forwarded.

  async onDiscover(): Promise<void> {
    await this.host.callHook('onDiscover', [])
  }
  async onLoad(): Promise<void> {
    await this.host.callHook('onLoad', [])
  }
  async onConfigure(): Promise<void> {
    await this.host.callHook('onConfigure', [])
  }
  async onStart(): Promise<void> {
    await this.host.callHook('onStart', [])
  }
  async onStop(_ctx: unknown, reason: StopReason): Promise<void> {
    await this.host.callHook('onStop', [reason])
  }
  async onUnload(): Promise<void> {
    await this.host.callHook('onUnload', [])
  }
  async onDispose(): Promise<void> {
    await this.host.callHook('onDispose', [])
    await this.host.terminate()
  }
  async onHealthCheck(): Promise<'healthy' | 'degraded' | 'unhealthy'> {
    const value = await this.host.callHook('onHealthCheck', [])
    const valid = value as string | undefined
    if (valid === 'healthy' || valid === 'degraded' || valid === 'unhealthy') {
      return valid
    }
    return 'unhealthy'
  }
}
