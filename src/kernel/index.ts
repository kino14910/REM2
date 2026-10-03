/**
 * rem2-kernel 公共出口（docs/02 §K.3）。
 *
 * 插件与测试**只能**从本出口引用内核；不得深链 `src/kernel/**` 内部实现。
 * 契约测试 `tests/contract/plugin-contract.test.ts` 断言此约束。
 */

// ── 契约（类型 + 唯一运行时构造器 ServiceToken） ──
export type {
  PluginManifest,
  Compatibility,
  Plugin,
  PluginModuleExport,
  LifecyclePhase,
  StopReason,
  PluginContext,
  PluginApi,
  ExportOptions,
  ServiceDescriptor,
  ServiceFactory,
  Lifetime,
  LifetimeValue,
  ServiceRegistry,
  Container,
  Unsubscribe,
  OnOptions,
  RequestOptions,
  EventHandler,
  EventBus,
  ConfigProvider,
  ConfigAccess,
  ConfigLayer,
  ConfigChangeHandler,
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
  HealthStatus,
  PluginHealthInfo,
  HealthReport,
  HealthCheckFn,
  Capability,
  TrustLevel,
  PermissionDecision,
  PermissionSet,
  TrustPolicy,
  PublicPluginState,
  PluginInfo,
  PluginsRegistryView,
  Span,
  SpanData,
  Tracer,
  TraceExporter,
} from './contracts/index.js';

export { ServiceToken } from './contracts/service-token.js';
export { LOG_LEVEL_ORDER } from './contracts/logging.js';
export { KERNEL_METRICS } from './contracts/metrics.js';

// ── 内核令牌与版本 ──
export { KernelTokens } from './contracts/kernel-tokens.js';
export {
  KERNEL_VERSION,
  CONTRACT_VERSION,
  KERNEL_ID,
  MANIFEST_FILENAME,
} from './version.js';

// ── 编排层 ──
export { Kernel } from './kernel.js';
export { defaultKernelOptions } from './bootstrap/options.js';
export type { KernelOptions, PluginBootstrap } from './bootstrap/options.js';
export type { KernelStartResult, LoadedPlugin, PluginHealth } from './types.js';
export { PluginState } from './types.js';

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
} from './errors.js';

// ── 内核可被测试/工具复用的公共设施（保持最小集） ──
export { validateManifest } from './discovery/manifest-validator.js';
export { DiContainer } from './di/container.js';
export { ServiceRegistryFacade } from './di/service-registry.js';
export { Lifetime as LifetimeEnum } from './di/lifetime.js';
export { KernelEventBus } from './events/event-bus.js';
export { satisfies, isValidRange } from './semver/range.js';
export {
  parseVersion,
  compareVersions,
  isValidVersion,
} from './semver/semver.js';
export { DependencyResolver } from './dependency/resolver.js';
export { PluginDiscovery } from './discovery/discovery.js';
export type { Candidate, CandidateSource } from './discovery/candidate.js';
export { ConfigService } from './config/config-service.js';
export { MemoryConfigProvider } from './config/memory-provider.js';
export { LogService } from './observability/log-service.js';
export { MemoryLogSink, NullLogSink } from './observability/null-sink.js';
export { MetricsService } from './observability/metrics-service.js';
export {
  MemoryMetricSink,
  NoopMetricSink,
} from './observability/noop-metrics-sink.js';
export { TracingService } from './observability/tracing-service.js';
export { HealthService } from './observability/health-service.js';
export { PermissionManager } from './security/permission-manager.js';
export { CapabilityGuard } from './security/capability-guard.js';
export {
  DEFAULT_TRUST_POLICY,
  trustLevelFor,
} from './security/trust-policy.js';
export { SerialScheduler } from './scheduler/serial-scheduler.js';
export type { Scheduler, SchedulerTask } from './scheduler/scheduler.js';
export type { ResolveIssue, ResolutionPlan } from './dependency/resolver.js';
