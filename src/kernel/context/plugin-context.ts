/**
 * 插件上下文构造：由 Kernel 在加载插件时调用，组装 `PluginContext`。
 *
 * 变更：`ctx.extensions` 是插件**唯一**的能力贡献入口（P3）。
 * Worker 隔离下的扩展点贡献由 `isolation/worker-plugin-proxy.ts` 承载，
 * 且只允许 `log.sink` / `metrics.sink` / `trace.exporter` 三类（值须可结构化克隆）。
 */

import path from 'node:path';
import type { PluginContext } from '../contracts/context.js';
import type { PluginManifest } from '../contracts/manifest.js';
import type { LifecyclePhase } from '../contracts/lifecycle.js';
import type { PluginStateT } from '../contracts/plugins.js';
import type { PermissionSet } from '../contracts/permission.js';
import type { Container } from '../contracts/container.js';
import type { ServicesView } from '../contracts/service.js';
import type { EventBus } from '../contracts/event-bus.js';
import type { ConfigAccess } from '../contracts/config.js';
import type { Logger } from '../contracts/logging.js';
import type { MetricsApi } from '../contracts/metrics.js';
import type { PluginsRegistryView } from '../contracts/plugins.js';
import type { ExtensionContributorView } from '../contracts/extension-point.js';
import { PluginApiImpl } from './plugin-api.js';
import type { PluginApiHooks } from './plugin-api.js';
import type { Container as DiContainer } from '../di/container.js';
import type { CapabilityGuard } from '../security/capability-guard.js';
import type { PluginsRegistry } from '../registry/plugins-registry.js';
import { PHASE_OF_STATE } from '../state-machine.js';
import { EntryEscapeError } from '../errors.js';

/** 构造上下文所需的内核设施。 */
export interface ContextDeps {
  events: EventBus;
  config: ConfigAccess;
  logService: { child(scope: string, pluginId?: string): Logger };
  metrics: MetricsApi;
  registry: PluginsRegistry;
  guard: CapabilityGuard;
  /** 本插件的扩展点贡献视图。 */
  extensions: ExtensionContributorView;
  /** 状态读取器（返回当前插件的逻辑状态）。 */
  stateOf: (pluginId: string) => PluginStateT;
  /** 导出挂载钩子（由内核提供，避免插件 API 触碰父容器）。 */
  mountExported: PluginApiHooks['mountExported'];
  unmountExported: PluginApiHooks['unmountExported'];
}

export function createPluginContext(
  manifest: PluginManifest,
  rootDir: string,
  container: Container,
  permissions: PermissionSet,
  deps: ContextDeps,
): PluginContext {
  const diContainer = container as DiContainer;
  const pluginId = manifest.id;

  const api = new PluginApiImpl(pluginId, diContainer, deps.guard, {
    mountExported: deps.mountExported,
    unmountExported: deps.unmountExported,
  });

  // services 视图：限定在本插件子容器内注册/解析（解析时可向上到内核容器）。
  // 解析路径**必须经过 CapabilityGuard** —— 声明了所需能力的服务未授权即抛
  // CapabilityDeniedError；未声明能力的服务视为公共设施。
  const services: ServicesView = {
    register: (token, factory, lifetime) => {
      diContainer.register(token, factory, lifetime);
      return services;
    },
    registerInstance: (token, instance) => {
      diContainer.registerInstance(token, instance);
      return services;
    },
    resolve: (token) => {
      deps.guard.assert(token.id, pluginId);
      return diContainer.resolve(token);
    },
    tryResolve: (token) => {
      try {
        deps.guard.assert(token.id, pluginId);
      } catch {
        return undefined;
      }
      return diContainer.tryResolve(token);
    },
    has: (token) => diContainer.has(token),
    list: () => diContainer.list(),
  };

  const context: PluginContext = {
    pluginId,
    manifest,
    get phase(): LifecyclePhase {
      return PHASE_OF_STATE[deps.stateOf(pluginId)];
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
      const resolved = path.resolve(rootDir, relative);
      const rel = path.relative(rootDir, resolved);
      // 入口沙箱：插件不得借 resolvePath 越出 rootDir（docs/03 §6.3）。
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new EntryEscapeError(pluginId, relative);
      }
      return resolved;
    },
  };

  return context;
}
