/**
 * 插件上下文构造（docs/02 §F.3）。
 *
 * 由 Kernel 在加载插件时调用，组装 PluginContext。
 */

import path from 'node:path';
import type { PluginContext } from '../contracts/context.js';
import type { PluginManifest } from '../contracts/manifest.js';
import type { LifecyclePhase } from '../contracts/lifecycle.js';
import type { PermissionSet } from '../contracts/permission.js';
import type { Container } from '../contracts/di-container.js';
import type { ServiceRegistry } from '../contracts/service.js';
import type { EventBus } from '../contracts/event-bus.js';
import type { ConfigAccess } from '../contracts/config.js';
import type { Logger } from '../contracts/logging.js';
import type { MetricsApi } from '../contracts/metrics.js';
import type { PluginsRegistryView } from '../contracts/plugins.js';
import { PluginApiImpl } from './plugin-api.js';
import type { PluginApiHooks } from './plugin-api.js';
import type { Container as DiContainer } from '../di/container.js';
import type { CapabilityGuard } from '../security/capability-guard.js';
import type { PluginsRegistry } from '../registry/plugins-registry.js';

/** 构造上下文所需的内核设施。 */
export interface ContextDeps {
  events: EventBus;
  config: ConfigAccess;
  logService: { child(scope: string, pluginId?: string): Logger };
  metrics: MetricsApi;
  registry: PluginsRegistry;
  guard: CapabilityGuard;
  /** 阶段读取器（返回当前插件阶段）。 */
  phaseOf: (pluginId: string) => LifecyclePhase;
  /** 导出挂载钩子（由内核提供，避免插件 API 触碰父容器）。 */
  mountExported: PluginApiHooks['mountExported'];
  unmountExported: PluginApiHooks['unmountExported'];
}

/**
 * 创建插件上下文。
 *
 * @param candidateRootDir 插件根目录（供 resolvePath）
 * @param container 插件子容器
 * @param permissions 该插件的权限集
 */
export function createPluginContext(
  manifest: PluginManifest,
  rootDir: string,
  container: Container,
  permissions: PermissionSet,
  deps: ContextDeps,
): PluginContext {
  const diContainer = container as DiContainer;

  // 插件 API：导出/使用能力（受能力代理约束；挂载动作委托内核，插件 API 不触碰父容器）。
  const api = new PluginApiImpl(manifest.id, diContainer, deps.guard, {
    mountExported: deps.mountExported,
    unmountExported: deps.unmountExported,
  });

  // services 视图：限定在本插件子容器内注册/解析（解析时可向上到内核容器）。
  // 安全要点（动机 #7 的修正）：解析路径**必须经过 CapabilityGuard**——
  // 声明了所需能力的服务（含敏感内核服务令牌），未授权插件解析即抛
  // CapabilityDeniedError；未声明能力的服务视为公共设施，直接放行。
  const services: ServiceRegistry = {
    register: (token, factory, lifetime) => {
      diContainer.register(token, factory, lifetime);
      return services;
    },
    registerInstance: (token, instance) => {
      diContainer.registerInstance(token, instance);
      return services;
    },
    resolve: (token) => {
      deps.guard.assert(token.id, manifest.id);
      return diContainer.resolve(token);
    },
    tryResolve: (token) => {
      try {
        deps.guard.assert(token.id, manifest.id);
      } catch {
        return undefined;
      }
      return diContainer.tryResolve(token);
    },
    has: (token) => diContainer.has(token),
    list: () => diContainer.list(),
  };

  const context: PluginContext = {
    pluginId: manifest.id,
    manifest,
    container,
    services,
    events: deps.events,
    config: deps.config,
    log: deps.logService.child(`plugin:${manifest.id}`, manifest.id),
    metrics: deps.metrics,
    permissions,
    api,
    get phase(): LifecyclePhase {
      return deps.phaseOf(manifest.id);
    },
    plugins: deps.registry as PluginsRegistryView,
    resolvePath: (relative: string): string => path.resolve(rootDir, relative),
  };

  return context;
}
