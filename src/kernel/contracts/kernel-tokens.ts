/**
 * 内核服务令牌（内核与插件之间的「公共语言」）。
 *
 * 只描述**服务身份**，不含实现。`Scheduler` 指向实现层的 `Scheduler` 接口
 * （这是全仓库唯一一处契约层引用实现层类型的地方，理由：`Scheduler` 是可替换端口，
 * 端口形状本身即契约）。
 */

import { defineToken } from './service-token.js';
import type { Scheduler } from '../scheduler/scheduler.js';

export const KernelTokens = {
  EventBus: defineToken<import('./event-bus.js').EventBus>({
    id: 'kernel.event-bus',
    describe: '全局事件总线',
  }),
  Config: defineToken<import('./config.js').ConfigAccess>({
    id: 'kernel.config',
    describe: '配置只读访问',
  }),
  ConfigService: defineToken<import('./config.js').ConfigAccess>({
    id: 'kernel.config-service',
    describe: '配置服务（含 provider 管理）',
  }),
  Log: defineToken<unknown>({
    id: 'kernel.log',
    describe: '日志服务',
  }),
  Metrics: defineToken<import('./metrics.js').MetricsApi>({
    id: 'kernel.metrics',
    describe: '指标服务',
  }),
  Tracer: defineToken<import('./tracing.js').Tracer>({
    id: 'kernel.tracer',
    describe: '追踪服务（span 采集与导出）',
  }),
  Health: defineToken<unknown>({
    id: 'kernel.health',
    describe: '健康服务',
  }),
  Permissions: defineToken<unknown>({
    id: 'kernel.permissions',
    describe: '权限管理器',
  }),
  Plugins: defineToken<import('./plugins.js').PluginsRegistryView>({
    id: 'kernel.plugins',
    describe: '插件注册表视图',
  }),
  Scheduler: defineToken<Scheduler>({
    id: 'kernel.scheduler',
    describe: '调度器（可经 scheduler.replace 扩展点替换）',
  }),
  Resolver: defineToken<unknown>({
    id: 'kernel.resolver',
    describe: '依赖解析器（可经 resolver.replace 扩展点替换）',
  }),
  Discovery: defineToken<unknown>({
    id: 'kernel.discovery',
    describe: '插件发现器',
  }),
  Loader: defineToken<unknown>({
    id: 'kernel.loader',
    describe: '插件加载器（可经 loader.replace 扩展点替换）',
  }),
  CapabilityGuard: defineToken<unknown>({
    id: 'kernel.capability-guard',
    describe: '能力代理',
  }),
  Extensions: defineToken<unknown>({
    id: 'kernel.extensions',
    describe: '扩展点注册表',
  }),
  /** 宿主提供的 UI 侧服务：主题注册表（`ui.theme` 单例槽的宿主默认实现所引用的服务）。 */
  UiThemeRegistry: defineToken<import('./ui.js').ThemeRegistry>({
    id: 'host.ui.theme-registry',
    describe: '宿主主题注册表',
    capability: 'ui.theme',
  }),
  /** 宿主提供的 UI 侧服务：面板/路由宿主读取入口。 */
  UiPanelHost: defineToken<unknown>({
    id: 'host.ui.panel-host',
    describe: '宿主 UI 面板读取入口',
    capability: 'ui.panel',
  }),
} as const;

/** 内核服务令牌类型别名。 */
export type KernelToken = (typeof KernelTokens)[keyof typeof KernelTokens];
