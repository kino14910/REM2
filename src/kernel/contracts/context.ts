/**
 * Plugin context and plugin API contracts.
 *
 * Capability contributions have a single entry point:
 * `ctx.extensions.contribute`. The former `PluginApi.registerCapability`
 * was removed because ad-hoc registration bypassed the extension point
 * registry.
 */

import type { PluginManifest } from './manifest.js'
import type { ServicesView } from './service.js'
import type { ServiceToken } from './service-token.js'
import type { Container } from './container.js'
import type { EventBus } from './event-bus.js'
import type { ConfigAccess } from './config.js'
import type { Logger } from './logging.js'
import type { MetricsApi } from './metrics.js'
import type { PermissionSet } from './permission.js'
import type { LifecyclePhase } from './lifecycle.js'
import type { PluginsRegistryView } from './plugins.js'
import type { ExtensionContributorView } from './extension-point.js'

export interface ExportOptions {
  /** Capability required to export this service; other plugins resolving it are checked through a capability proxy. */
  capability?: string
}

/**
 * Plugin API: the cross-boundary call surface constrained by the
 * capability proxy.
 *
 * Covers services only; capability contributions go through
 * `ctx.extensions`.
 */
export interface PluginApi {
  /** Explicitly export a service of this plugin (does not leak to the parent container by default). */
  export<T>(token: ServiceToken<T>, opts?: ExportOptions): void
  unexport<T>(token: ServiceToken<T>): void
  /** Resolve a service exported by another plugin (through the permission proxy). */
  useCapability<T>(token: ServiceToken<T>): T
}

/** Context passed to plugin hooks; exposes only the permitted handles. */
export interface PluginContext {
  readonly pluginId: string
  readonly manifest: Readonly<PluginManifest>
  /** Current lifecycle phase (read-only; reflects the logical state machine position). */
  readonly phase: LifecyclePhase
  /** This plugin's child container (its parent is unreachable from the plugin). */
  readonly container: Container
  /** Services view: register and resolve this plugin's own services (resolve passes through CapabilityGuard). */
  readonly services: ServicesView
  /** Global event bus. */
  readonly events: EventBus
  /** Read-only config access (consumer side). */
  readonly config: ConfigAccess
  /** Plugin-scoped logger. */
  readonly log: Logger
  /** Metrics API (consumer side). */
  readonly metrics: MetricsApi
  /** Permission set granted to this plugin (read-only snapshot). */
  readonly permissions: PermissionSet
  /** Extension contribution entry point (the only mounting surface). */
  readonly extensions: ExtensionContributorView
  /** Plugin API (export/use capabilities). */
  readonly api: PluginApi
  /** Plugins view: probe whether other plugins exist (runtime probing for soft dependencies). */
  readonly plugins: PluginsRegistryView
  /** Resolves a relative path to an absolute path under the plugin rootDir; escaping the root throws EntryEscapeError. */
  resolvePath(relative: string): string
}
