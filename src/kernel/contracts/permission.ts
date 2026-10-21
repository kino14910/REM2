/**
 * Permission and capability contracts (types only).
 *
 * Three-stage model: manifest `requires` declares -> PermissionManager authorizes -> CapabilityGuard intercepts.
 * Extension point contributions are also subject to capability checks: unauthorized contributions fail instead of being silently ignored.
 */

/** Capability name (hierarchically namespaced, e.g. 'log.sink' / 'ui.panel' / 'kernel.internals'). */
export type Capability = string

export type TrustLevel = 'trusted' | 'sandboxed'

export interface PermissionDecision {
  granted: string[]
  denied: string[]
  warnings: Array<{ capability: string; reason: string }>
}

export interface PermissionSet {
  readonly pluginId: string
  readonly granted: readonly string[]
  readonly denied: readonly string[]
  isGranted(capability: string): boolean
}

export interface TrustPolicy {
  /** Capabilities granted by default per trust level (supports prefix wildcards, e.g. 'log.*'). */
  defaults: Record<TrustLevel, string[]>
  /** Capability prefixes that trigger a user warning when granted. */
  warnOn: Record<TrustLevel, string[]>
}

/**
 * Capability constants recognized by the kernel.
 *
 * Scattered capability strings fail silently on typos (PermissionManager only
 * matches against warnOn/defaults), so they are consolidated here as constants.
 * New capabilities must also be added to the defaults/warnOn in security/trust-policy.ts.
 */
export const Capabilities = {
  LogSink: 'log.sink',
  MetricsSink: 'metrics.sink',
  TraceExporter: 'trace.exporter',
  ConfigProvider: 'config.provide',
  CommandProvide: 'command.provide',
  HealthExpose: 'health.expose',
  UiTheme: 'ui.theme',
  /** Contribute a declarative panel. */
  UiPanel: 'ui.panel',
  /** Contribute a declarative route. */
  UiRoute: 'ui.route',
  /** Replaces kernel internals such as the scheduler, resolver, or loader. */
  KernelInternals: 'kernel.internals',
  /** Write path for configuration. */
  ConfigAdmin: 'kernel.config.admin',
  /** Write path for permission management. */
  PermissionsAdmin: 'kernel.permissions.admin',
  FsRead: 'fs.read',
  NetListen: 'net.listen',
} as const
