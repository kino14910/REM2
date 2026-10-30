/**
 * The only public entry point of `rem2-kernel`.
 *
 * Plugins and tests must reference the kernel only through this entry point;
 * deep-linking into `src/kernel/**` internals is not allowed, and the contract
 * test `tests/contract/plugin-contract.test.ts` asserts this constraint.
 *
 * The export surface is deliberately narrowed to four categories:
 * contract types + pure function factories, `KernelTokens`, error classes and
 * version constants. No implementation classes are exported: the old surface
 * exported 20+ implementation classes, letting plugins fake kernel services
 * with `new ConfigService()` and rendering the boundary meaningless.
 */

export type {
  // Manifest
  Compatibility,
  PluginManifest,
  PluginManifestInit,
  ManifestContribution,
  // Plugin shape
  PluginFactory,
  PluginFactoryHooks,
  PluginHookName,
  PluginModuleExport,
  // Lifecycle
  LifecyclePhase,
  StopReason,
  PhaseOutcome,
  // Context
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
  // Event bus
  Unsubscribe,
  OnOptions,
  RequestOptions,
  EventHandler,
  EventBus,
  // Config
  ConfigProvider,
  ConfigAccess,
  ConfigLayer,
  ConfigChangeHandler,
  // Observability
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
  // Permissions
  Capability,
  TrustLevel,
  PermissionDecision,
  PermissionSet,
  TrustPolicy,
  // Plugin state
  PluginStateT,
  PluginInfo,
  PluginsRegistryView,
  // Extension points
  ExtensionPointId,
  ExtensionPointDef,
  ExtensionConflictPolicy,
  ExtensionContribution,
  ExtensionContributorView,
  ExtensionPointSummary,
  // UI
  ThemeDefinition,
  ThemeMode,
  ThemeRegistry,
  PanelContribution,
  PanelRegion,
  PanelFormData,
  PanelFormField,
  PanelFormOption,
  RouteContribution,
} from './contracts/index.js'

// ── Pure function factories (the only runtime behavior here) ──
export { defineToken } from './contracts/service-token.js'
export { definePlugin } from './define-plugin.js'

// ── Constant tables ──
export { LOG_LEVEL_ORDER } from './contracts/logging.js'
export { KERNEL_METRICS } from './contracts/metrics.js'
export { PLUGIN_STATES, TERMINAL_STATES } from './contracts/plugins.js'
export { PLUGIN_HOOK_NAMES } from './contracts/plugin.js'
export { Capabilities } from './contracts/permission.js'
export { Topics } from './topics.js'
export type { TopicKey, TopicValue } from './topics.js'

// ── Kernel tokens and versions ──
export { KernelTokens } from './contracts/kernel-tokens.js'
export type { KernelToken } from './contracts/kernel-tokens.js'
export {
  KERNEL_VERSION,
  CONTRACT_VERSION,
  KERNEL_ID,
  MANIFEST_FILENAME,
} from './version.js'

// ── Errors ──
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
} from './errors.js'
export type { KernelErrorCode } from './errors.js'
