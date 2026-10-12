/**
 * 插件上下文与插件 API 契约（纯类型）。
 *
 * 变更（docs/13 D5）：`PluginApi.registerCapability` **已删除** ——
 * 能力贡献退化为不可枚举的散装注册，且绕过扩展点注册表（P3 红线）。
 * 贡献的唯一入口是 `ctx.extensions.contribute`。
 */

import type { PluginManifest } from './manifest.js';
import type { ServicesView } from './service.js';
import type { ServiceToken } from './service-token.js';
import type { Container } from './container.js';
import type { EventBus } from './event-bus.js';
import type { ConfigAccess } from './config.js';
import type { Logger } from './logging.js';
import type { MetricsApi } from './metrics.js';
import type { PermissionSet } from './permission.js';
import type { LifecyclePhase } from './lifecycle.js';
import type { PluginsRegistryView } from './plugins.js';
import type { ExtensionContributorView } from './extension-point.js';

/** 插件导出服务时的选项。 */
export interface ExportOptions {
  /** 导出该服务需要的能力；其他插件解析它时将被代理校验。 */
  capability?: string;
}

/**
 * 插件 API：受能力代理约束的跨界调用入口。
 *
 * 只管「服务」；「能力贡献」走 `ctx.extensions`。
 */
export interface PluginApi {
  /** 显式导出本插件服务（默认不泄漏到父容器）。 */
  export<T>(token: ServiceToken<T>, opts?: ExportOptions): void;
  /** 取消导出。 */
  unexport<T>(token: ServiceToken<T>): void;
  /** 解析其他插件导出的服务（走权限代理）。 */
  useCapability<T>(token: ServiceToken<T>): T;
}

/** 传递给插件钩子的上下文。只暴露「被允许」的句柄。 */
export interface PluginContext {
  readonly pluginId: string;
  readonly manifest: Readonly<PluginManifest>;
  /** 当前生命周期阶段（只读，反映逻辑状态机当前位置）。 */
  readonly phase: LifecyclePhase;
  /** 该插件的子容器（其 parent 对插件不可达）。 */
  readonly container: Container;
  /** 服务视图：本插件注册/解析自身服务（resolve 经 CapabilityGuard）。 */
  readonly services: ServicesView;
  /** 全局事件总线。 */
  readonly events: EventBus;
  /** 配置只读访问（消费侧）。 */
  readonly config: ConfigAccess;
  /** 插件作用域日志器。 */
  readonly log: Logger;
  /** 指标 API（消费侧）。 */
  readonly metrics: MetricsApi;
  /** 本插件被授予的权限集（只读快照）。 */
  readonly permissions: PermissionSet;
  /** 扩展点贡献入口（P3 唯一挂载面）。 */
  readonly extensions: ExtensionContributorView;
  /** 插件 API（导出/使用能力）。 */
  readonly api: PluginApi;
  /** 插件视图：探测其他插件是否已存在（软依赖运行期探测）。 */
  readonly plugins: PluginsRegistryView;
  /** 把相对路径解析为相对插件 rootDir 的绝对路径；越界抛 EntryEscapeError。 */
  resolvePath(relative: string): string;
}
