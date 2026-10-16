/**
 * 内核核心设施集合与 root 容器注册。
 *
 * 变更（docs/06 §1.2 #10）：本文件从「注册动作」改为**返回 `KernelDeps`** ——
 * 装配职责整体移交给 `composition.ts`，`Kernel` 构造器不再 `new` 14 个实现类。
 */

import type { Container } from '../di/container.js';
import { KernelTokens } from '../contracts/kernel-tokens.js';
import { Capabilities } from '../contracts/permission.js';
import type { EventBus } from '../contracts/event-bus.js';
import type { ConfigService } from '../config/config-service.js';
import type { LogService } from '../observability/log-service.js';
import type { MetricsService } from '../observability/metrics-service.js';
import type { TracingService } from '../observability/tracing-service.js';
import type { HealthService } from '../observability/health-service.js';
import type { PermissionManager } from '../security/permission-manager.js';
import type { CapabilityGuard } from '../security/capability-guard.js';
import type { PluginsRegistry } from '../registry/plugins-registry.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { DependencyResolver } from '../dependency/resolver.js';
import type { PluginDiscovery } from '../discovery/discovery.js';
import type { PluginLoader } from '../loader/loader.js';
import type { ExtensionPointRegistry } from '../extensions/registry.js';

/** 内核核心设施集合（= `KernelDeps` 的服务部分）。 */
export interface CoreServices {
  events: EventBus;
  config: ConfigService;
  log: LogService;
  metrics: MetricsService;
  health: HealthService;
  tracer: TracingService;
  permissions: PermissionManager;
  guard: CapabilityGuard;
  registry: PluginsRegistry;
  scheduler: Scheduler;
  resolver: DependencyResolver;
  discovery: PluginDiscovery;
  loader: PluginLoader;
  extensions: ExtensionPointRegistry;
}

/**
 * 把核心服务注册进 root 容器，并登记**敏感内核服务**的能力门槛。
 *
 * root 容器 shareable=true 意味着插件子容器可向上解析一切内核服务；
 * 若不声明能力门槛，插件可绕过 CapabilityGuard 直达 ConfigService 写路径、
 * Loader、Resolver 等强力设施。
 */
export function registerCoreServices(
  container: Container,
  core: CoreServices,
): void {
  container.registerInstance(KernelTokens.EventBus, core.events);
  container.registerInstance(KernelTokens.Config, core.config);
  container.registerInstance(KernelTokens.ConfigService, core.config);
  container.registerInstance(KernelTokens.Log, core.log);
  container.registerInstance(KernelTokens.Metrics, core.metrics);
  container.registerInstance(KernelTokens.Tracer, core.tracer);
  container.registerInstance(KernelTokens.Health, core.health);
  container.registerInstance(KernelTokens.Permissions, core.permissions);
  container.registerInstance(KernelTokens.Plugins, core.registry);
  container.registerInstance(KernelTokens.Scheduler, core.scheduler);
  container.registerInstance(KernelTokens.Resolver, core.resolver);
  container.registerInstance(KernelTokens.Discovery, core.discovery);
  container.registerInstance(KernelTokens.Loader, core.loader);
  container.registerInstance(KernelTokens.CapabilityGuard, core.guard);
  container.registerInstance(KernelTokens.Extensions, core.extensions);

  core.guard.declareServiceCapability(
    KernelTokens.ConfigService.id,
    Capabilities.ConfigAdmin,
  );
  core.guard.declareServiceCapability(
    KernelTokens.Permissions.id,
    Capabilities.PermissionsAdmin,
  );
  core.guard.declareServiceCapability(
    KernelTokens.Scheduler.id,
    Capabilities.KernelInternals,
  );
  core.guard.declareServiceCapability(
    KernelTokens.Resolver.id,
    Capabilities.KernelInternals,
  );
  core.guard.declareServiceCapability(
    KernelTokens.Discovery.id,
    Capabilities.KernelInternals,
  );
  core.guard.declareServiceCapability(
    KernelTokens.Loader.id,
    Capabilities.KernelInternals,
  );
  core.guard.declareServiceCapability(
    KernelTokens.CapabilityGuard.id,
    Capabilities.KernelInternals,
  );
  core.guard.declareServiceCapability(
    KernelTokens.Extensions.id,
    Capabilities.KernelInternals,
  );
}
