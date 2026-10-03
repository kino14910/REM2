/**
 * 注册内核自身服务（docs/02 §B.3 / §F.4）。
 *
 * 内核把自身的公共设施注册到 root 容器，供插件 resolve；同时也在 root 容器上
 * 注册"可替换点"的默认实现（Scheduler / Resolver），这些可被插件覆盖。
 */

import type { DiContainer } from '../di/container.js';
import { KernelTokens } from '../contracts/kernel-tokens.js';
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

/** 内核核心设施集合。 */
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
}

/**
 * 把核心服务注册进 root 容器。
 *
 * 同时登记**敏感内核服务**的能力要求（动机 #7 的修正）：
 * root 容器 shareable=true 意味着插件子容器可向上解析一切内核服务；
 * 若不在这里声明能力门槛，插件可绕过 CapabilityGuard 直达 ConfigService 写路径、
 * Loader、Resolver 等强力设施。登记后，插件必须在 manifest 声明对应能力且被授予，
 * 才能经 `ctx.services.resolve` 解析成功。
 *
 * 公共（无门槛）：EventBus / Config(只读) / Log / Metrics / Health / Plugins 视图。
 */
export function registerCoreServices(
  container: DiContainer,
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

  // 敏感内核服务 → 所需能力（插件侧 resolve 时由 CapabilityGuard 强制校验）。
  core.guard.declareServiceCapability(
    KernelTokens.ConfigService.id,
    'kernel.config.admin',
  );
  core.guard.declareServiceCapability(
    KernelTokens.Permissions.id,
    'kernel.permissions.admin',
  );
  core.guard.declareServiceCapability(
    KernelTokens.Scheduler.id,
    'kernel.internals',
  );
  core.guard.declareServiceCapability(
    KernelTokens.Resolver.id,
    'kernel.internals',
  );
  core.guard.declareServiceCapability(
    KernelTokens.Discovery.id,
    'kernel.internals',
  );
  core.guard.declareServiceCapability(
    KernelTokens.Loader.id,
    'kernel.internals',
  );
  core.guard.declareServiceCapability(
    KernelTokens.CapabilityGuard.id,
    'kernel.internals',
  );
}
