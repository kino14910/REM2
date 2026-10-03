/**
 * 插件上下文与插件 API 契约（纯类型）。见 docs/02 §F.3 / §E.4。
 */

import type { PluginManifest } from './manifest.js';
import type { ServiceRegistry } from './service.js';
import type { ServiceToken } from './service-token.js';
import type { Container } from './di-container.js';
import type { EventBus } from './event-bus.js';
import type { ConfigAccess } from './config.js';
import type { Logger } from './logging.js';
import type { MetricsApi } from './metrics.js';
import type { PermissionSet } from './permission.js';
import type { LifecyclePhase } from './lifecycle.js';
import type { PluginsRegistryView } from './plugins.js';

/** 插件导出服务时的选项。 */
export interface ExportOptions {
  /** 导出该服务需要的能力；其他插件解析它时将被代理校验。 */
  capability?: string;
}

/**
 * 插件 API：受能力代理约束的跨界调用入口（动机 #7）。
 */
export interface PluginApi {
  /** 显式导出本插件服务（默认不泄漏到父容器）。 */
  export<T>(token: ServiceToken<T>, opts?: ExportOptions): void;

  /** 取消导出。 */
  unexport<T>(token: ServiceToken<T>): void;

  /** 解析其他插件导出的服务（走权限代理）。 */
  useCapability<T>(token: ServiceToken<T>): T;

  /** 声明/注册一个能力实现（用于运行期能力发现）。 */
  registerCapability(name: string, impl: unknown): void;
}

/**
 * 传递给插件钩子的上下文。只暴露「被允许」的句柄。
 */
export interface PluginContext {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  /** 该插件的子容器（其 parent 为内核 root 容器）。 */
  readonly container: Container;
  /** 服务注册表：本插件注册/解析自身服务。 */
  readonly services: ServiceRegistry;
  /** 全局事件总线。 */
  readonly events: EventBus;
  /** 配置只读访问（消费侧）。 */
  readonly config: ConfigAccess;
  /** 插件作用域日志器。 */
  readonly log: Logger;
  /** 指标 API（消费侧）。 */
  readonly metrics: MetricsApi;
  /** 本插件被授予的权限集。 */
  readonly permissions: PermissionSet;
  /** 插件 API（导出/使用能力）。 */
  readonly api: PluginApi;
  /** 当前生命周期阶段（可读，动机 #4）。 */
  readonly phase: LifecyclePhase;
  /** 插件视图：探测其他插件是否已存在（软依赖运行期探测）。 */
  readonly plugins: PluginsRegistryView;
  /** 把相对路径解析为相对插件 rootDir 的绝对路径。 */
  resolvePath(relative: string): string;
}
