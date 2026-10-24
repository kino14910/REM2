/**
 * Default service assembly: the only place that news up the kernel's services.
 *
 * One of only two assembly points in the repo (the other is kernel.ts
 * itself); both are the documented exception to the no-concrete-import rule.
 *
 * Assembly order has dependencies and must not be reordered:
 * guard (no deps) -> permissions (needs guard) -> extensions (needs
 * permissions, because contributions are capability-checked) -> remaining
 * services -> host default extension implementations -> core services.
 */

import { Container } from './di/container.js'
import { EventBusImpl } from './events/event-bus.js'
import { ConfigService } from './config/config-service.js'
import {
  MemoryConfigProvider,
  ReadOnlyMemoryConfigProvider,
} from './config/memory-provider.js'
import { LogService } from './observability/log-service.js'
import { MetricsService } from './observability/metrics-service.js'
import { TracingService } from './observability/tracing-service.js'
import { HealthService } from './observability/health-service.js'
import { PermissionManager } from './security/permission-manager.js'
import { CapabilityGuard } from './security/capability-guard.js'
import { PluginsRegistry } from './registry/plugins-registry.js'
import { SerialScheduler } from './scheduler/serial-scheduler.js'
import { DependencyResolver } from './dependency/resolver.js'
import { PluginDiscovery } from './discovery/discovery.js'
import { PluginLoader } from './loader/loader.js'
import { LifecycleManager } from './lifecycle/manager.js'
import { ExtensionPointRegistry } from './extensions/registry.js'
import { CommandDispatcher } from './extensions/command-dispatcher.js'
import { EXTENSION_POINT_DEFS } from './extensions/definitions.js'
import {
  registerHostConfigLayer,
  registerHostSinks,
} from './observability/extension-sinks.js'
import {
  registerCoreServices,
  type CoreServices,
} from './bootstrap/register-core-services.js'
import {
  defaultKernelOptions,
  type KernelOptions,
} from './bootstrap/options.js'
import { KERNEL_VERSION, CONTRACT_VERSION } from './version.js'
import { KERNEL_METRICS } from './contracts/metrics.js'
import type { Candidate } from './discovery/candidate.js'
import type { PluginContext } from './contracts/context.js'
import type { Container as ContainerContract } from './contracts/container.js'
import { createPluginContext } from './context/plugin-context.js'
import type { LoadOptions } from './loader/loader.js'
import type { ResolveIssue } from './dependency/resolver.js'

/**
 * All dependencies of Kernel.
 *
 * The Kernel constructor receives only this object and never news up
 * implementation classes, so tests can inject fakes and assembly stays
 * type-separated from orchestration.
 */
export interface KernelDeps extends CoreServices {
  options: KernelOptions
  rootContainer: Container
  lifecycle: LifecycleManager
  /** Issues produced by dependency resolution (read by the CLI and tests). */
  resolveIssues: () => readonly ResolveIssue[]
  /** Plan produced by the resolver (consumed by ports such as `loader.replace`). */
  planOf: (candidates: Candidate[]) => ReturnType<DependencyResolver['resolve']>
  /** Builds the context for the current plugin (used by the loader and the IPC bridge). */
  contextOf: (
    candidate: Candidate,
    container: ContainerContract,
  ) => PluginContext
  /**
   * Single dispatch path for `command.execute` (registered as a bus responder
   * by the kernel at start(); not a KernelToken because the host and plugins
   * never resolve it - they only observe its effect).
   */
  commandDispatcher: CommandDispatcher
}

export type CreateDepsOptions = Partial<KernelOptions>

/**
 * Create a default set of kernel dependencies.
 *
 * Host default extension implementations (NullLogSink / NoopMetricSink /
 * span buffering / read-only memory config layer / SerialScheduler /
 * built-in DependencyResolver / built-in PluginLoader) are registered here;
 * plugins replace any of them via the corresponding `*.replace` extension point.
 */
export function createDeps(partial: CreateDepsOptions = {}): KernelDeps {
  const options = defaultKernelOptions(partial)
  const version = KERNEL_VERSION

  const guard = new CapabilityGuard()
  const permissions = new PermissionManager(guard)
  const extensions = new ExtensionPointRegistry({ permissions })
  extensions.defineAll(EXTENSION_POINT_DEFS)
  // Reads the command.provide slot directly; never requests the bus itself.
  const commandDispatcher = new CommandDispatcher(extensions)

  const log = new LogService(options.logLevel)
  const metrics = new MetricsService()
  const tracer = new TracingService()
  const registry = new PluginsRegistry()

  const config = new ConfigService({
    // Config provider failures must be observable (never silently degrade).
    onProviderError: failure => {
      log
        .child('kernel.config')
        .warn(
          `config provider failed to load: ${failure.provider} - ${failure.error}`,
        )
      metrics
        .counter(KERNEL_METRICS.configProviderError, {
          provider: failure.provider,
        })
        .add(1)
    },
  })

  const health = new HealthService(version, registry, extensions)
  const scheduler = new SerialScheduler()
  const resolver = new DependencyResolver()
  const discovery = new PluginDiscovery()
  const rootContainer = new Container({ scope: 'root', shareable: true })

  const resolveIssuesRef: { current: ResolveIssue[] } = { current: [] }

  const events = new EventBusImpl({
    onHandlerError: (event, _error, pluginId) => {
      metrics
        .counter(KERNEL_METRICS.eventHandlerError, {
          event,
          ...(pluginId ? { pluginId } : {}),
        })
        .add(1)
    },
  })

  const lifecycle = new LifecycleManager({
    startTimeoutMs: options.startTimeoutMs,
    stopTimeoutMs: options.stopTimeoutMs,
    onPhase: (pluginId, phase, durationMs, ok) => {
      metrics
        .histogram(KERNEL_METRICS.lifecycleDuration, { phase, pluginId })
        .observe(durationMs)
      const span = tracer.startSpan(`plugin.lifecycle.${phase}`, { pluginId })
      span.setAttribute('durationMs', durationMs)
      span.setAttribute('ok', ok)
      span.end()
      if (!ok) {
        metrics
          .counter(KERNEL_METRICS.eventHandlerError, { pluginId, phase })
          .add(1)
      }
    },
  })

  // Kernel default layer for config providers: the host default implementation of the `config.provider` extension point.
  config.registerProvider(
    new ReadOnlyMemoryConfigProvider({ app: { name: 'rem2' } }),
  )
  registerHostConfigLayer(extensions)

  const contextOf = (
    candidate: Candidate,
    container: ContainerContract,
  ): PluginContext =>
    createPluginContext(
      candidate.manifest,
      candidate.rootDir,
      container,
      permissions.get(candidate.manifest.id) ?? {
        pluginId: candidate.manifest.id,
        granted: [],
        denied: [],
        isGranted: () => false,
      },
      {
        events,
        config,
        logService: log,
        metrics,
        registry,
        guard,
        extensions: {
          contribute: (point, contribution) => {
            extensions.contribute(candidate.manifest.id, point, contribution)
          },
          retract: (point, contributionId) => {
            extensions.retract(point, contributionId)
          },
        },
        stateOf: pluginId =>
          registry.getLoaded(pluginId)?.state ?? 'Registered',
        // Export mounting is done by the kernel: the plugin API never holds a parent container reference.
        mountExported: child => rootContainer.mountChildContainer(child),
        unmountExported: child => rootContainer.unmountChildContainer(child),
      },
    )

  const loader = new PluginLoader({
    createContainer: pluginId =>
      rootContainer.createChild(`plugin:${pluginId}`),
    createContext: contextOf,
    permissionsOf: pluginId => permissions.get(pluginId),
    workerFacilities: {
      events,
      config,
      logService: log,
      metrics,
      extensions: {
        contribute: (pluginId, point, contribution) => {
          extensions.contribute(pluginId, point as never, contribution as never)
        },
      },
      onUnexpectedExit: () => undefined,
    },
  })

  registerHostSinks(extensions, { log, metrics, tracer })

  extensions.registerHostDefault('scheduler.replace', {
    contributionId: 'kernel.serial',
    impl: scheduler,
  })
  extensions.registerHostDefault('resolver.replace', {
    contributionId: 'kernel.builtin',
    impl: resolver,
  })
  extensions.registerHostDefault('loader.replace', {
    contributionId: 'kernel.builtin',
    impl: loader,
  })

  const core: CoreServices = {
    events,
    config,
    log,
    metrics,
    health,
    tracer,
    permissions,
    guard,
    registry,
    scheduler,
    resolver,
    discovery,
    loader,
    extensions,
  }
  registerCoreServices(rootContainer, core)

  // Initial config: inject the highest-priority writable memory layer.
  config.registerProvider(
    new MemoryConfigProvider(options.initialConfig ?? {}, 'memory', 1000),
  )

  return {
    ...core,
    options,
    rootContainer,
    lifecycle,
    resolveIssues: () => resolveIssuesRef.current,
    planOf: (candidates: Candidate[]) => {
      const plan = resolver.resolve(candidates, {
        kernelVersion: version,
        contractVersion: CONTRACT_VERSION,
        onError: options.onResolveError,
      })
      resolveIssuesRef.current = plan.issues
      return plan
    },
    contextOf,
    commandDispatcher,
  }
}

/** Per-load options for the loader (re-exported so hosts take this type from composition only). */
export type { LoadOptions }
