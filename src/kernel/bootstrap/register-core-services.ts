import type { Container } from '../di/container.js'
import { KernelTokens } from '../contracts/kernel-tokens.js'
import { Capabilities } from '../contracts/permission.js'
import type { EventBus } from '../contracts/event-bus.js'
import type { ConfigService } from '../config/config-service.js'
import type { LogService } from '../observability/log-service.js'
import type { MetricsService } from '../observability/metrics-service.js'
import type { TracingService } from '../observability/tracing-service.js'
import type { HealthService } from '../observability/health-service.js'
import type { PermissionManager } from '../security/permission-manager.js'
import type { CapabilityGuard } from '../security/capability-guard.js'
import type { PluginsRegistry } from '../registry/plugins-registry.js'
import type { Scheduler } from '../scheduler/scheduler.js'
import type { DependencyResolver } from '../dependency/resolver.js'
import type { PluginDiscovery } from '../discovery/discovery.js'
import type { PluginLoader } from '../loader/loader.js'
import type { ExtensionPointRegistry } from '../extensions/registry.js'

/** Kernel core service collection (the service portion of `KernelDeps`). */
export interface CoreServices {
  events: EventBus
  config: ConfigService
  log: LogService
  metrics: MetricsService
  health: HealthService
  tracer: TracingService
  permissions: PermissionManager
  guard: CapabilityGuard
  registry: PluginsRegistry
  scheduler: Scheduler
  resolver: DependencyResolver
  discovery: PluginDiscovery
  loader: PluginLoader
  extensions: ExtensionPointRegistry
}

/**
 * Register core services into the root container and declare capability gates
 * for sensitive kernel services.
 *
 * The root container is shareable, so plugin child containers can resolve any
 * kernel service upward; without these gates a plugin could bypass
 * CapabilityGuard and directly reach the ConfigService write path, the Loader,
 * the Resolver and other powerful facilities.
 */
export function registerCoreServices(
  container: Container,
  core: CoreServices,
): void {
  container.registerInstance(KernelTokens.EventBus, core.events)
  container.registerInstance(KernelTokens.Config, core.config)
  container.registerInstance(KernelTokens.ConfigService, core.config)
  container.registerInstance(KernelTokens.Log, core.log)
  container.registerInstance(KernelTokens.Metrics, core.metrics)
  container.registerInstance(KernelTokens.Tracer, core.tracer)
  container.registerInstance(KernelTokens.Health, core.health)
  container.registerInstance(KernelTokens.Permissions, core.permissions)
  container.registerInstance(KernelTokens.Plugins, core.registry)
  container.registerInstance(KernelTokens.Scheduler, core.scheduler)
  container.registerInstance(KernelTokens.Resolver, core.resolver)
  container.registerInstance(KernelTokens.Discovery, core.discovery)
  container.registerInstance(KernelTokens.Loader, core.loader)
  container.registerInstance(KernelTokens.CapabilityGuard, core.guard)
  container.registerInstance(KernelTokens.Extensions, core.extensions)

  core.guard.declareServiceCapability(
    KernelTokens.ConfigService.id,
    Capabilities.ConfigAdmin,
  )
  core.guard.declareServiceCapability(
    KernelTokens.Permissions.id,
    Capabilities.PermissionsAdmin,
  )
  core.guard.declareServiceCapability(
    KernelTokens.Scheduler.id,
    Capabilities.KernelInternals,
  )
  core.guard.declareServiceCapability(
    KernelTokens.Resolver.id,
    Capabilities.KernelInternals,
  )
  core.guard.declareServiceCapability(
    KernelTokens.Discovery.id,
    Capabilities.KernelInternals,
  )
  core.guard.declareServiceCapability(
    KernelTokens.Loader.id,
    Capabilities.KernelInternals,
  )
  core.guard.declareServiceCapability(
    KernelTokens.CapabilityGuard.id,
    Capabilities.KernelInternals,
  )
  core.guard.declareServiceCapability(
    KernelTokens.Extensions.id,
    Capabilities.KernelInternals,
  )
}
