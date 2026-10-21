/**
 * Extension point contracts (the "language" side of the P3 principle).
 *
 * An extension point is an explicit declaration of a replaceable host capability:
 * id, singleton vs. multi-contribution, host default implementation, conflict
 * resolution policy, and required capability. Anything the host can replace must
 * have an id here, otherwise ctx.extensions.contribute has nowhere to register it
 * (P3: everything goes through the extension point registry).
 */

import type { Capability } from './permission.js'

/**
 * Union of extension point ids. Adding an extension point requires all of:
 * 1. a literal here; 2. an ExtensionPointDef entry in extensions/definitions.ts;
 * 3. if it has a capability, a constant in permission.ts plus a trust-policy ruling.
 */
export type ExtensionPointId =
  | 'log.sink'
  | 'metrics.sink'
  | 'trace.exporter'
  | 'config.provider'
  | 'command.provide'
  | 'health.check'
  | 'ui.theme'
  | 'ui.panel'
  | 'ui.route'
  | 'scheduler.replace'
  | 'resolver.replace'
  | 'loader.replace'

/** Conflict resolution policy (only meaningful for singleton slots). */
export type ExtensionConflictPolicy =
  | 'reject-new'
  | 'replace-old'
  | 'keep-first'

export interface ExtensionPointDef<T> {
  readonly id: ExtensionPointId
  readonly describe: string
  /** Multiple contributions or singleton. Singleton conflicts are resolved by the kernel at registration. */
  readonly multi: boolean
  /** Whether the host provides a default implementation (registered before startup, pluginId = 'kernel'). */
  readonly hasHostDefault: boolean
  /** Conflict resolution policy (only meaningful for singleton slots). */
  readonly conflict: ExtensionConflictPolicy
  /** Capability this extension point requires (a plugin must hold it when contributing). */
  readonly capability?: Capability
  /** Type inference only; does not exist at runtime. */
  readonly __type?: T
}

export interface ExtensionContribution<T> {
  /** Unique within the slot (singleton slots use it for conflict resolution; multi-contribution slots for reclamation and listing). */
  readonly contributionId: string
  readonly impl: T
}

/** Contribution entry point visible to plugins (the type of ctx.extensions). */
export interface ExtensionContributorView {
  /** Contributes to an extension point. An unknown point id throws UnknownExtensionPointError. */
  contribute<T>(
    point: ExtensionPointId,
    contribution: ExtensionContribution<T>,
  ): void
  /** Retracts one of this plugin's contributions (usually unnecessary: the kernel force-reclaims everything on uninstall). */
  retract(point: ExtensionPointId, contributionId: string): void
}

/** Extension point enumeration entry (return item of registry.list()). */
export interface ExtensionPointSummary {
  point: ExtensionPointId
  multi: boolean
  contributions: string[]
}
