/**
 * 默认服务装配（`Kernel` 构造器里 14 个 `new` 的唯一去处）。
 *
 * 这是全仓库**仅有的两个装配点**之一（另一个是 `kernel.ts` 本身）——
 * docs/13 §3.3 明确把这两处列为 D7「不得 import 具体实现类」的例外。
 *
 * 装配顺序有依赖，不可随意调换：
 * ① guard（无依赖）→ ② permissions（依赖 guard）→ ③ extensions（依赖 permissions，
 * 因为贡献时要校验能力）→ ④ 其余服务 → ⑤ 注册宿主默认扩展点实现 → ⑥ 注册核心服务。
 */

import { Container } from './di/container.js';
import { EventBusImpl } from './events/event-bus.js';
import { ConfigService } from './config/config-service.js';
import {
  MemoryConfigProvider,
  ReadOnlyMemoryConfigProvider,
} from './config/memory-provider.js';
import { LogService } from './observability/log-service.js';
import { MetricsService } from './observability/metrics-service.js';
import { TracingService } from './observability/tracing-service.js';
import { HealthService } from './observability/health-service.js';
import { PermissionManager } from './security/permission-manager.js';
import { CapabilityGuard } from './security/capability-guard.js';
import { PluginsRegistry } from './registry/plugins-registry.js';
import { SerialScheduler } from './scheduler/serial-scheduler.js';
import { DependencyResolver } from './dependency/resolver.js';
import { PluginDiscovery } from './discovery/discovery.js';
import { PluginLoader } from './loader/loader.js';
import { LifecycleManager } from './lifecycle/manager.js';
import { ExtensionPointRegistry } from './extensions/registry.js';
import { EXTENSION_POINT_DEFS } from './extensions/definitions.js';
import {
  registerHostConfigLayer,
  registerHostSinks,
} from './observability/extension-sinks.js';
import { registerCoreServices, type CoreServices } from './bootstrap/register-core-services.js';
import { defaultKernelOptions, type KernelOptions } from './bootstrap/options.js';
import { KERNEL_VERSION, CONTRACT_VERSION } from './version.js';
import { KERNEL_METRICS } from './contracts/metrics.js';
import type { Candidate } from './discovery/candidate.js';
import type { PluginContext } from './contracts/context.js';
import type { Container as ContainerContract } from './contracts/container.js';
import { createPluginContext } from './context/plugin-context.js';
import type { LoadOptions } from './loader/loader.js';
import type { ResolveIssue } from './dependency/resolver.js';

/**
 * `Kernel` 的全部依赖。
 *
 * `Kernel` 构造器只接收本对象，**不 new 任何实现类**（docs/13 C16）。
 * 这让测试可以注入替身，也让「装配」与「编排」两件事在类型上分离。
 */
export interface KernelDeps extends CoreServices {
  /** 归一化后的内核选项。 */
  options: KernelOptions;
  /** root 容器（shareable）。 */
  rootContainer: Container;
  /** 生命周期管理器。 */
  lifecycle: LifecycleManager;
  /** 依赖解析产生的 issues（供 CLI / 测试读取）。 */
  resolveIssues: () => readonly ResolveIssue[];
  /** 解析器产出的计划（供 `loader.replace` 等端口消费）。 */
  planOf: (candidates: Candidate[]) => ReturnType<DependencyResolver['resolve']>;
  /** 解析当前插件的上下文（供 loader 与 IPC 桥使用）。 */
  contextOf: (candidate: Candidate, container: ContainerContract) => PluginContext;
}

/** 装配选项（与 `KernelOptions` 同形，便于 `createDeps(options)` 直传）。 */
export type CreateDepsOptions = Partial<KernelOptions>;

/**
 * 创建一套默认内核依赖。
 *
 * 宿主默认扩展点实现（NullLogSink / NoopMetricSink / span 缓冲 / 只读内存配置层 /
 * SerialScheduler / 内置 DependencyResolver / 内置 PluginLoader）在这一步注册；
 * 插件若要替换其中任何一个，走对应的 `*.replace` 扩展点。
 */
export function createDeps(partial: CreateDepsOptions = {}): KernelDeps {
  const options = defaultKernelOptions(partial);
  const version = KERNEL_VERSION;

  const guard = new CapabilityGuard();
  const permissions = new PermissionManager(guard);
  const extensions = new ExtensionPointRegistry({ permissions });
  extensions.defineAll(EXTENSION_POINT_DEFS);

  const log = new LogService(options.logLevel);
  const metrics = new MetricsService();
  const tracer = new TracingService();
  const registry = new PluginsRegistry();

  const config = new ConfigService({
    // 配置 provider 失败必须可观测（绝不静默降级）。
    onProviderError: (failure) => {
      log
        .child('kernel.config')
        .warn(
          `配置 provider 加载失败：${failure.provider} - ${failure.error}`,
        );
      metrics
        .counter(KERNEL_METRICS.configProviderError, { provider: failure.provider })
        .add(1);
    },
  });

  const health = new HealthService(version, registry, extensions);
  const scheduler = new SerialScheduler();
  const resolver = new DependencyResolver();
  const discovery = new PluginDiscovery();
  const rootContainer = new Container({ scope: 'root', shareable: true });

  const resolveIssuesRef: { current: ResolveIssue[] } = { current: [] };

  const events = new EventBusImpl({
    onHandlerError: (event, _error, pluginId) => {
      metrics
        .counter(KERNEL_METRICS.eventHandlerError, {
          event,
          ...(pluginId ? { pluginId } : {}),
        })
        .add(1);
    },
  });

  const lifecycle = new LifecycleManager({
    startTimeoutMs: options.startTimeoutMs,
    stopTimeoutMs: options.stopTimeoutMs,
    onPhase: (pluginId, phase, durationMs, ok) => {
      metrics
        .histogram(KERNEL_METRICS.lifecycleDuration, { phase, pluginId })
        .observe(durationMs);
      const span = tracer.startSpan(`plugin.lifecycle.${phase}`, { pluginId });
      span.setAttribute('durationMs', durationMs);
      span.setAttribute('ok', ok);
      span.end();
      if (!ok) {
        metrics
          .counter(KERNEL_METRICS.eventHandlerError, { pluginId, phase })
          .add(1);
      }
    },
  });

  // 配置 provider 的内核默认层：`config.provider` 扩展点的宿主默认实现。
  config.registerProvider(
    new ReadOnlyMemoryConfigProvider({ app: { name: 'rem2' } }),
  );
  registerHostConfigLayer(extensions);

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
            extensions.contribute(
              candidate.manifest.id,
              point,
              contribution,
            );
          },
          retract: (point, contributionId) => {
            extensions.retract(point, contributionId);
          },
        },
        stateOf: (pluginId) => registry.getLoaded(pluginId)?.state ?? 'Registered',
        // 导出挂载由内核完成：插件 API 不持有父容器引用。
        mountExported: (child) => rootContainer.mountChildContainer(child),
        unmountExported: (child) => rootContainer.unmountChildContainer(child),
      },
    );

  const loader = new PluginLoader({
    createContainer: (pluginId) =>
      rootContainer.createChild(`plugin:${pluginId}`),
    createContext: contextOf,
    permissionsOf: (pluginId) => permissions.get(pluginId),
    workerFacilities: {
      events,
      config,
      logService: log,
      metrics,
      extensions: {
        contribute: (pluginId, point, contribution) => {
          extensions.contribute(pluginId, point as never, contribution as never);
        },
      },
      onUnexpectedExit: () => undefined,
    },
  });

  // sink 三个扩展点的宿主默认实现（NullLogSink / NoopMetricSink / span 缓冲）。
  registerHostSinks(extensions, { log, metrics, tracer });

  // 三个 `*.replace` 扩展点的宿主默认实现。
  extensions.registerHostDefault('scheduler.replace', {
    contributionId: 'kernel.serial',
    impl: scheduler,
  });
  extensions.registerHostDefault('resolver.replace', {
    contributionId: 'kernel.builtin',
    impl: resolver,
  });
  extensions.registerHostDefault('loader.replace', {
    contributionId: 'kernel.builtin',
    impl: loader,
  });

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
  };
  registerCoreServices(rootContainer, core);

  // 初始配置：注入最高优先级的可写内存层。
  config.registerProvider(
    new MemoryConfigProvider(options.initialConfig ?? {}, 'memory', 1000),
  );

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
      });
      resolveIssuesRef.current = plan.issues;
      return plan;
    },
    contextOf,
  };
}

/** loader 的单次加载选项（重导出以便宿主只从 composition 取类型）。 */
export type { LoadOptions };
