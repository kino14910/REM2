/**
 * 插件契约层统一出口（纯类型 + 少量纯函数/常量）。
 *
 * 约定：contracts 只描述「内核与插件之间的语言」，不含任何具体能力实现。
 * 本层唯一的运行期导出是纯函数（`defineToken` / `definePlugin`）与常量表。
 */

// ── 清单 ──
export type {
  Compatibility,
  PluginManifest,
  PluginManifestInit,
  ManifestContribution,
} from './manifest.js';

// ── 插件形态 ──
export type {
  PluginFactory,
  PluginFactoryHooks,
  PluginHookName,
  PluginModuleExport,
} from './plugin.js';
export { PLUGIN_HOOK_NAMES } from './plugin.js';

// ── 生命周期 ──
export type {
  LifecyclePhase,
  StopReason,
  PhaseOutcome,
} from './lifecycle.js';

// ── 上下文 ──
export type {
  PluginContext,
  PluginApi,
  ExportOptions,
} from './context.js';

// ── DI ──
export type {
  ServiceDescriptor,
  ServiceFactory,
  Lifetime,
  LifetimeValue,
  ServiceToken,
} from './service-token.js';
export { defineToken } from './service-token.js';
export type { ServiceRegistry, ServicesView } from './service.js';
export type { Container } from './container.js';

// ── 事件总线 ──
export type {
  Unsubscribe,
  OnOptions,
  RequestOptions,
  EventHandler,
  EventBus,
} from './event-bus.js';

// ── 配置 ──
export type {
  ConfigProvider,
  ConfigAccess,
  ConfigLayer,
  ConfigChangeHandler,
} from './config.js';

// ── 可观测性 ──
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

// ── 权限 ──
export type {
  Capability,
  TrustLevel,
  PermissionDecision,
  PermissionSet,
  TrustPolicy,
} from './permission.js';
export { Capabilities } from './permission.js';

// ── 插件状态与注册表 ──
export { PLUGIN_STATES, TERMINAL_STATES } from './plugins.js';
export type {
  PluginStateT,
  PluginInfo,
  PluginsRegistryView,
} from './plugins.js';

// ── 扩展点 ──
export type {
  ExtensionPointId,
  ExtensionPointDef,
  ExtensionConflictPolicy,
  ExtensionContribution,
  ExtensionContributorView,
  ExtensionPointSummary,
} from './extension-point.js';

// ── UI ──
export type {
  ThemeDefinition,
  ThemeRegistry,
  PanelContribution,
  PanelRegion,
  RouteContribution,
} from './ui.js';
