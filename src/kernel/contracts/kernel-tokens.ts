/**
 * 内核服务令牌与依赖契约（docs/02 §B.5 / §F.4）。
 *
 * 这些 token 是内核与插件之间的"公共语言"，供插件 resolve 内核设施。
 * `KernelTokens` 对象即内核的公共 API 出口之一。
 */

import { ServiceToken } from './service-token.js';

/**
 * 内核核心服务令牌。
 *
 * 注意：`KernelTokens` 只描述"服务身份"，不含实现。
 */
export const KernelTokens = {
  EventBus: ServiceToken.create<import('./event-bus.js').EventBus>({
    id: 'kernel.event-bus',
    describe: '全局事件总线',
  }),
  Config: ServiceToken.create<import('./config.js').ConfigAccess>({
    id: 'kernel.config',
    describe: '配置只读访问',
  }),
  ConfigService: ServiceToken.create<import('./config.js').ConfigAccess>({
    id: 'kernel.config-service',
    describe: '配置服务（含 provider 管理）',
  }),
  Log: ServiceToken.create<unknown>({
    id: 'kernel.log',
    describe: '日志服务',
  }),
  Metrics: ServiceToken.create<import('./metrics.js').MetricsApi>({
    id: 'kernel.metrics',
    describe: '指标服务',
  }),
  Tracer: ServiceToken.create<import('./tracing.js').Tracer>({
    id: 'kernel.tracer',
    describe: '追踪服务（span 采集与导出）',
  }),
  Health: ServiceToken.create<unknown>({
    id: 'kernel.health',
    describe: '健康服务',
  }),
  Permissions: ServiceToken.create<unknown>({
    id: 'kernel.permissions',
    describe: '权限管理器',
  }),
  Plugins: ServiceToken.create<import('./plugins.js').PluginsRegistryView>({
    id: 'kernel.plugins',
    describe: '插件注册表视图',
  }),
  Scheduler: ServiceToken.create<import('../scheduler/scheduler.js').Scheduler>(
    {
      id: 'kernel.scheduler',
      describe: '调度器（可被插件替换）',
    },
  ),
  Resolver: ServiceToken.create<unknown>({
    id: 'kernel.resolver',
    describe: '依赖解析器（可被插件替换）',
  }),
  Discovery: ServiceToken.create<unknown>({
    id: 'kernel.discovery',
    describe: '插件发现器',
  }),
  Loader: ServiceToken.create<unknown>({
    id: 'kernel.loader',
    describe: '插件加载器',
  }),
  CapabilityGuard: ServiceToken.create<unknown>({
    id: 'kernel.capability-guard',
    describe: '能力代理',
  }),
} as const;

/** 内核服务令牌类型别名。 */
export type KernelToken = (typeof KernelTokens)[keyof typeof KernelTokens];
