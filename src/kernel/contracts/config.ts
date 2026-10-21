/**
 * Config contracts.
 *
 * Core principle: the kernel only defines the ConfigProvider contract;
 * where configuration comes from is entirely up to plugins.
 */

import type { Unsubscribe } from './event-bus.js'

export interface ConfigProvider {
  /** Provider name, e.g. 'json' / 'env' / 'memory' / 'remote'. */
  readonly name: string
  /** Layer priority; larger values sit above smaller ones and override them. Kernel defaults: memory=1000, env=100, json=10. */
  readonly priority: number
  /** Loads the entire configuration as a flat key->value map. */
  load(): Promise<Record<string, unknown>>
  /** Optional: reload (triggered by file watching). */
  reload?(): Promise<Record<string, unknown>>
  onDidChange?(cb: (changedKeys: string[]) => void): Unsubscribe
  /** Optional: write; read-only providers may throw NotWritableError. */
  set?(key: string, value: unknown): Promise<void>
}

/** Config layer description (for debugging and display). */
export interface ConfigLayer {
  name: string
  priority: number
}

export type ConfigChangeHandler = (changedKeys: string[], key: string) => void

/**
 * Read-only config access interface for plugins (the type of
 * `PluginContext.config`); implemented by the kernel ConfigService.
 */
export interface ConfigAccess {
  get<T>(key: string, defaultValue?: T): T
  getOrThrow<T>(key: string): T
  has(key: string): boolean
  onDidChange(cb: ConfigChangeHandler): Unsubscribe
}
