/**
 * Input/output shapes for the loader port (helper types for ports.ts, avoiding circular imports).
 */

import type { PluginContext } from '../contracts/context.js'
import type { PluginFactoryHooks } from '../contracts/plugin.js'
import type { PluginManifest } from '../contracts/manifest.js'
import type { PluginStateT } from '../contracts/plugins.js'
import type { Container } from '../contracts/container.js'
import type { PermissionSet } from '../contracts/permission.js'
import type { HealthStatus } from '../contracts/health.js'

export interface PluginLoaderOptions {
  /**
   * Cache-busting marker for hot reload: when set, appended as a query to the import
   * specifier so Node's ESM module cache treats it as a new module.
   */
  cacheBust?: string
}

export interface PluginHealth {
  status: HealthStatus
  message?: string
  checkedAt?: number
}

export interface LoadedPlugin {
  manifest: PluginManifest
  hooks: PluginFactoryHooks
  context: PluginContext
  container: Container
  state: PluginStateT
  health: PluginHealth
  rootDir: string
  /** Permission set granted to this plugin (CapabilityGuard relies on it for deny decisions). */
  permissions: PermissionSet
}
