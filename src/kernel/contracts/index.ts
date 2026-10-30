/**
 * Contracts layer barrel.
 *
 * The contracts layer only describes the language between kernel and
 * plugins; its only runtime exports are pure functions (`defineToken` /
 * `definePlugin`) and constant tables.
 */

// ── manifest ──
export type {
  Compatibility,
  PluginManifest,
  PluginManifestInit,
  ManifestContribution,
} from './manifest.js'

// ── plugin shape ──
export type {
  PluginFactory,
  PluginFactoryHooks,
  PluginHookName,
  PluginModuleExport,
} from './plugin.js'
export { PLUGIN_HOOK_NAMES } from './plugin.js'

// ── lifecycle ──
export type { LifecyclePhase, StopReason, PhaseOutcome } from './lifecycle.js'

// ── context ──
export type { PluginContext, PluginApi, ExportOptions } from './context.js'

// ── DI ──
export type {
  ServiceDescriptor,
  ServiceFactory,
  Lifetime,
  LifetimeValue,
  ServiceToken,
} from './service-token.js'
export { defineToken } from './service-token.js'
export type { ServiceRegistry, ServicesView } from './service.js'
export type { Container } from './container.js'

// ── event bus ──
export type {
  Unsubscribe,
  OnOptions,
  RequestOptions,
  EventHandler,
  EventBus,
} from './event-bus.js'

// ── config ──
export type {
  ConfigProvider,
  ConfigAccess,
  ConfigLayer,
  ConfigChangeHandler,
} from './config.js'

// ── observability ──
export type { LogLevel, LogEntry, LogSink, Logger } from './logging.js'
export { LOG_LEVEL_ORDER } from './logging.js'
export type {
  Labels,
  MetricRecord,
  MetricSink,
  Counter,
  Gauge,
  Histogram,
  MetricsApi,
} from './metrics.js'
export { KERNEL_METRICS } from './metrics.js'
export type { Span, SpanData, Tracer, TraceExporter } from './tracing.js'
export type {
  HealthStatus,
  PluginHealthInfo,
  HealthReport,
  HealthCheckFn,
} from './health.js'

// ── permissions ──
export type {
  Capability,
  TrustLevel,
  PermissionDecision,
  PermissionSet,
  TrustPolicy,
} from './permission.js'
export { Capabilities } from './permission.js'

// ── plugin state and registry ──
export { PLUGIN_STATES, TERMINAL_STATES } from './plugins.js'
export type {
  PluginStateT,
  PluginInfo,
  PluginsRegistryView,
} from './plugins.js'

// ── extension points ──
export type {
  ExtensionPointId,
  ExtensionPointDef,
  ExtensionConflictPolicy,
  ExtensionContribution,
  ExtensionContributorView,
  ExtensionPointSummary,
} from './extension-point.js'

// ── UI ──
export type {
  ThemeDefinition,
  ThemeMode,
  ThemeRegistry,
  PanelContribution,
  PanelRegion,
  PanelFormData,
  PanelFormField,
  PanelFormOption,
  RouteContribution,
} from './ui.js'
