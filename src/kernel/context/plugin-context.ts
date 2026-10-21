/**
 * Assembles the `PluginContext` for a plugin (invoked by the Kernel at load time).
 *
 * `ctx.extensions` is the only capability-contribution entry point for plugins (P3).
 * Under worker isolation, extension contributions are hosted by
 * `isolation/worker-plugin-proxy.ts` and limited to `log.sink` / `metrics.sink` /
 * `trace.exporter` (values must be structured-cloneable).
 */

import path from 'node:path'
import type { PluginContext } from '../contracts/context.js'
import type { PluginManifest } from '../contracts/manifest.js'
import type { LifecyclePhase } from '../contracts/lifecycle.js'
import type { PluginStateT } from '../contracts/plugins.js'
import type { PermissionSet } from '../contracts/permission.js'
import type { Container } from '../contracts/container.js'
import type { ServicesView } from '../contracts/service.js'
import type { EventBus } from '../contracts/event-bus.js'
import type { ConfigAccess } from '../contracts/config.js'
import type { Logger } from '../contracts/logging.js'
import type { MetricsApi } from '../contracts/metrics.js'
import type { PluginsRegistryView } from '../contracts/plugins.js'
import type { ExtensionContributorView } from '../contracts/extension-point.js'
import { PluginApiImpl } from './plugin-api.js'
import type { PluginApiHooks } from './plugin-api.js'
import type { Container as DiContainer } from '../di/container.js'
import type { CapabilityGuard } from '../security/capability-guard.js'
import type { PluginsRegistry } from '../registry/plugins-registry.js'
import { PHASE_OF_STATE } from '../state-machine.js'
import { EntryEscapeError } from '../errors.js'

/** Kernel facilities required to construct a context. */
export interface ContextDeps {
  events: EventBus
  config: ConfigAccess
  logService: { child(scope: string, pluginId?: string): Logger }
  metrics: MetricsApi
  registry: PluginsRegistry
  guard: CapabilityGuard
  /** Extension-point contribution view for this plugin. */
  extensions: ExtensionContributorView
  /** State reader (returns the current plugin's logical state). */
  stateOf: (pluginId: string) => PluginStateT
  /** Export mounting hooks (provided by the kernel so the plugin API never touches the parent container). */
  mountExported: PluginApiHooks['mountExported']
  unmountExported: PluginApiHooks['unmountExported']
}

export function createPluginContext(
  manifest: PluginManifest,
  rootDir: string,
  container: Container,
  permissions: PermissionSet,
  deps: ContextDeps,
): PluginContext {
  const diContainer = container as DiContainer
  const pluginId = manifest.id

  const api = new PluginApiImpl(pluginId, diContainer, deps.guard, {
    mountExported: deps.mountExported,
    unmountExported: deps.unmountExported,
  })

  // services view: registration and resolution are confined to this plugin's
  // child container (resolution may delegate up to the kernel container).
  // Resolution must pass through CapabilityGuard: a service that declares a
  // required capability throws CapabilityDeniedError when unauthorized;
  // services without declared capabilities are treated as public facilities.
  const services: ServicesView = {
    register: (token, factory, lifetime) => {
      diContainer.register(token, factory, lifetime)
      return services
    },
    registerInstance: (token, instance) => {
      diContainer.registerInstance(token, instance)
      return services
    },
    resolve: token => {
      deps.guard.assert(token.id, pluginId)
      return diContainer.resolve(token)
    },
    tryResolve: token => {
      try {
        deps.guard.assert(token.id, pluginId)
      } catch {
        return undefined
      }
      return diContainer.tryResolve(token)
    },
    has: token => diContainer.has(token),
    list: () => diContainer.list(),
  }

  const context: PluginContext = {
    pluginId,
    manifest,
    get phase(): LifecyclePhase {
      return PHASE_OF_STATE[deps.stateOf(pluginId)]
    },
    container,
    services,
    events: deps.events,
    config: deps.config,
    log: deps.logService.child(`plugin:${pluginId}`, pluginId),
    metrics: deps.metrics,
    permissions,
    extensions: deps.extensions,
    api,
    plugins: deps.registry as PluginsRegistryView,
    resolvePath: (relative: string): string => {
      const resolved = path.resolve(rootDir, relative)
      const rel = path.relative(rootDir, resolved)
      // Entry sandbox: plugins must not use resolvePath to escape rootDir.
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new EntryEscapeError(pluginId, relative)
      }
      return resolved
    },
  }

  return context
}
