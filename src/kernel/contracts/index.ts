/**
 * 插件契约层统一出口（纯类型为主）。
 *
 * 约定（docs/02 §B.1）：contracts 只描述「内核与插件之间的语言」，
 * 不含任何具体能力实现。除 `ServiceToken` / 常量外，本层无可执行逻辑。
 */

export type { Compatibility, PluginManifest } from './manifest.js';

export type {
  LifecyclePhase,
  StopReason,
  Plugin,
  PluginModuleExport,
} from './lifecycle.js';

export type { PluginContext, PluginApi, ExportOptions } from './context.js';

export type {
  ServiceDescriptor,
  ServiceFactory,
  Lifetime,
  LifetimeValue,
  ServiceToken,
} from './service-token.js';
export { ServiceToken as ServiceTokenClass } from './service-token.js';

export type { ServiceRegistry } from './service.js';
export type { Container } from './di-container.js';

export type {
  Unsubscribe,
  OnOptions,
  RequestOptions,
  EventHandler,
  EventBus,
} from './event-bus.js';

export type {
  ConfigProvider,
  ConfigAccess,
  ConfigLayer,
  ConfigChangeHandler,
} from './config.js';

export type { LogLevel, LogEntry, LogSink, Logger } from './logging.js';
export { LOG_LEVEL_ORDER } from './logging.js';

export type {
  Labels,
  MetricRecord,
  MetricSink,
  Counter,
  Gauge,
  Histogram,
  MetricsApi,
} from './metrics.js';
export { KERNEL_METRICS } from './metrics.js';

export type { Span, SpanData, Tracer, TraceExporter } from './tracing.js';

export type {
  HealthStatus,
  PluginHealthInfo,
  HealthReport,
  HealthCheckFn,
} from './health.js';

export type {
  Capability,
  TrustLevel,
  PermissionDecision,
  PermissionSet,
  TrustPolicy,
} from './permission.js';

export type {
  PublicPluginState,
  PluginInfo,
  PluginsRegistryView,
} from './plugins.js';
