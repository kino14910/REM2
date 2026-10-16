/**
 * `rem2-kernel` 唯一公共出口。
 *
 * 插件与测试**只能**从本出口引用内核；不得深链 `src/kernel/**` 内部实现。
 * 契约测试 `tests/contract/plugin-contract.test.ts` 断言此约束。
 *
 * 导出面被刻意收窄为四类（docs/03 P7 / docs/06 D8）：
 * ① 契约类型 + 纯函数工厂；② `KernelTokens`；③ 错误类；④ 版本常量。
 * **不导出任何实现类** —— 旧版导出了 20+ 个实现类，插件可以 `new ConfigService()`
 * 造一个假内核服务，边界形同虚设。
 */

export type {
  // 清单
  Compatibility,
  PluginManifest,
  PluginManifestInit,
  ManifestContribution,
  // 插件形态
  PluginFactory,
  PluginFactoryHooks,
  PluginHookName,
  PluginModuleExport,
  // 生命周期
  LifecyclePhase,
  StopReason,
  PhaseOutcome,
  // 上下文
  PluginContext,
  PluginApi,
  ExportOptions,
  // DI
  ServiceDescriptor,
  ServiceFactory,
  Lifetime,
  LifetimeValue,
  ServiceToken,
  ServiceRegistry,
  ServicesView,
  Container,
  // 事件总线
  Unsubscribe,
  OnOptions,
  RequestOptions,
  EventHandler,
  EventBus,
  // 配置
  ConfigProvider,
  ConfigAccess,
  ConfigLayer,
  ConfigChangeHandler,
  // 可观测性
  LogLevel,
  LogEntry,
  LogSink,
  Logger,
  Labels,
  MetricRecord,
  MetricSink,
  Counter,
  Gauge,
  Histogram,
  MetricsApi,
  Span,
  SpanData,
  Tracer,
  TraceExporter,
  HealthStatus,
  PluginHealthInfo,
  HealthReport,
  HealthCheckFn,
  // 权限
  Capability,
  TrustLevel,
  PermissionDecision,
  PermissionSet,
  TrustPolicy,
  // 插件状态
  PluginStateT,
  PluginInfo,
  PluginsRegistryView,
  // 扩展点
  ExtensionPointId,
  ExtensionPointDef,
  ExtensionConflictPolicy,
  ExtensionContribution,
  ExtensionContributorView,
  ExtensionPointSummary,
  // UI
  ThemeDefinition,
  ThemeRegistry,
  PanelContribution,
  PanelRegion,
  RouteContribution,
} from './contracts/index.js';

// ── 纯函数工厂（唯一的运行期「做点事」的地方） ──
export { defineToken } from './contracts/service-token.js';
export { definePlugin } from './define-plugin.js';

// ── 常量表 ──
export { LOG_LEVEL_ORDER } from './contracts/logging.js';
export { KERNEL_METRICS } from './contracts/metrics.js';
export { PLUGIN_STATES, TERMINAL_STATES } from './contracts/plugins.js';
export { PLUGIN_HOOK_NAMES } from './contracts/plugin.js';
export { Capabilities } from './contracts/permission.js';
export { Topics } from './topics.js';
export type { TopicKey } from './topics.js';

// ── 内核令牌与版本 ──
export { KernelTokens } from './contracts/kernel-tokens.js';
export type { KernelToken } from './contracts/kernel-tokens.js';
export {
  KERNEL_VERSION,
  CONTRACT_VERSION,
  KERNEL_ID,
  MANIFEST_FILENAME,
} from './version.js';

// ── 错误 ──
export {
  KernelError,
  PluginError,
  TimeoutError,
  ResolveError,
  CircularDependencyError,
  NoProviderError,
  CapabilityDeniedError,
  ScopedAccessError,
  IllegalTransitionError,
  ManifestError,
  ManifestMismatchError,
  EntryEscapeError,
  NoResponderError,
  NotWritableError,
  UnknownExtensionPointError,
  ExtensionConflictError,
} from './errors.js';
export type { KernelErrorCode } from './errors.js';
