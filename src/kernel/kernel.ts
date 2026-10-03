/**
 * 内核（docs/02 §B）—— 最小编排者。
 *
 * 内核只做编排：发现 → 解析 → 加载 → 生命周期 → 隔离 → 关闭（§B.1）。
 * 一切具体功能（日志、配置、业务、运维、UI）都是插件（§M）。
 */

import { KERNEL_VERSION, CONTRACT_VERSION } from './version.js';
import type { KernelOptions } from './bootstrap/options.js';
import { defaultKernelOptions } from './bootstrap/options.js';
import {
  registerCoreServices,
  type CoreServices,
} from './bootstrap/register-core-services.js';
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
import {
  DependencyResolver,
  type ResolveIssue,
} from './dependency/resolver.js';
import { PluginDiscovery } from './discovery/discovery.js';
import { PluginLoader } from './loader/loader.js';
import type { LoadOptions } from './loader/loader.js';
import { LifecycleManager } from './lifecycle/lifecycle-manager.js';
import { createPluginContext } from './context/plugin-context.js';
import { trustLevelFor } from './security/trust-policy.js';
import {
  PluginState,
  type KernelStartResult,
  type LoadedPlugin,
} from './types.js';
import { KERNEL_METRICS } from './contracts/metrics.js';
import { KernelError } from './errors.js';
import { Topics } from './topics.js';
import type { Candidate } from './discovery/candidate.js';
import type { HealthReport } from './contracts/health.js';
import type { LifecyclePhase, StopReason } from './contracts/lifecycle.js';
import type { TrustLevel } from './contracts/permission.js';
import type { Container as DiContainer } from './di/container.js';

/** 单插件启动结果。 */
type StartOutcome = 'started' | 'degraded' | 'failed';

/**
 * 内核。
 */
export class Kernel {
  readonly id: string;
  readonly version = KERNEL_VERSION;
  readonly options: KernelOptions;

  private readonly rootContainer: Container;
  private readonly events: EventBusImpl;
  private readonly config: ConfigService;
  private readonly log: LogService;
  private readonly metrics: MetricsService;
  private readonly tracer: TracingService;
  private readonly guard: CapabilityGuard;
  private readonly permissions: PermissionManager;
  private readonly registry: PluginsRegistry;
  private readonly scheduler: SerialScheduler;
  private readonly resolver: DependencyResolver;
  private readonly discovery: PluginDiscovery;
  private readonly loader: PluginLoader;
  private readonly lifecycle: LifecycleManager;
  private readonly healthService: HealthService;

  private started = false;
  private reloadCounter = 0;
  private startResult: KernelStartResult = {
    loadOrder: [],
    started: [],
    degraded: [],
    failed: [],
  };
  private resolveIssues: ResolveIssue[] = [];

  constructor(options: Partial<KernelOptions> = {}) {
    this.options = defaultKernelOptions(options);
    this.id = this.options.id;

    // 核心设施
    this.rootContainer = new Container({ scope: 'root', shareable: true });
    this.config = new ConfigService({
      // 配置 provider 失败必须可观测（绝不静默降级）。
      onProviderError: (failure) => {
        this.log
          .child('kernel.config')
          .warn(
            `配置 provider 加载失败：${failure.provider} - ${failure.error}`,
          );
        this.metrics
          .counter(KERNEL_METRICS.configProviderError, {
            provider: failure.provider,
          })
          .add(1);
      },
    });
    this.log = new LogService(this.options.logLevel);
    this.metrics = new MetricsService();
    this.tracer = new TracingService();
    this.guard = new CapabilityGuard();
    this.permissions = new PermissionManager(this.guard);
    this.registry = new PluginsRegistry();
    this.scheduler = new SerialScheduler();
    this.resolver = new DependencyResolver();
    this.discovery = new PluginDiscovery();
    this.healthService = new HealthService(this.version, this.registry);

    // 事件总线：订阅者错误 → 指标（错误隔离，动机 #6）
    this.events = new EventBusImpl({
      onHandlerError: (event, _error, pluginId) => {
        this.metrics
          .counter(KERNEL_METRICS.eventHandlerError, {
            event,
            ...(pluginId ? { pluginId } : {}),
          })
          .add(1);
      },
    });

    // 生命周期管理器：阶段观测 → 指标 + 追踪 span
    this.lifecycle = new LifecycleManager({
      startTimeoutMs: this.options.startTimeoutMs,
      stopTimeoutMs: this.options.stopTimeoutMs,
      onPhase: (pluginId, phase, durationMs, ok) => {
        this.metrics
          .histogram(KERNEL_METRICS.lifecycleDuration, { phase, pluginId })
          .observe(durationMs);
        const span = this.tracer.startSpan(`plugin.lifecycle.${phase}`, {
          pluginId,
        });
        span.setAttribute('durationMs', durationMs);
        span.setAttribute('ok', ok);
        span.end();
        if (!ok) {
          this.metrics
            .counter(KERNEL_METRICS.eventHandlerError, { pluginId, phase })
            .add(1);
        }
      },
    });

    // 加载器：注入容器/上下文工厂
    this.loader = new PluginLoader({
      createContainer: (pluginId) =>
        this.rootContainer.createChild(`plugin:${pluginId}`),
      createContext: (candidate, _instance, container) =>
        createPluginContext(
          candidate.manifest,
          candidate.rootDir,
          container,
          this.permissions.get(candidate.manifest.id) ?? {
            pluginId: candidate.manifest.id,
            granted: [],
            denied: [],
            isGranted: () => false,
          },
          {
            events: this.events,
            config: this.config,
            logService: this.log,
            metrics: this.metrics,
            registry: this.registry,
            guard: this.guard,
            phaseOf: (pluginId) => this.phaseOf(pluginId),
            // 导出挂载由内核完成：插件 API 不持有父容器引用（动机 #7）。
            mountExported: (child) =>
              this.rootContainer.mountChildContainer(child),
            unmountExported: (child) =>
              this.rootContainer.unmountChildContainer(child),
          },
        ),
      // Worker 隔离宿主设施（isolation: 'worker' 插件）。
      workerFacilities: {
        events: this.events,
        config: this.config,
        logService: this.log,
        metrics: this.metrics,
        onUnexpectedExit: (pluginId, code, error) => {
          // Worker 崩溃：隔离为 Failed，内核与其他插件不受影响。
          this.registry.setState(pluginId, PluginState.Failed);
          this.registry.setHealth(pluginId, {
            status: 'unhealthy',
            message: error ?? `Worker 意外退出（code=${code ?? 'unknown'}）`,
            checkedAt: Date.now(),
          });
          this.metrics
            .counter(KERNEL_METRICS.pluginState, { pluginId, state: 'Failed' })
            .add(1);
          void this.events.emit(Topics.PluginFailed, {
            pluginId,
            error: error ?? `Worker 意外退出（code=${code ?? 'unknown'}）`,
          });
        },
      },
    });

    // 配置：内核默认内存层
    this.config.registerProvider(
      new ReadOnlyMemoryConfigProvider({ app: { name: 'rem2' } }),
    );
    this.config.registerProvider(
      new MemoryConfigProvider(
        this.options.initialConfig ?? {},
        'memory',
        1000,
      ),
    );

    // 注册核心服务到 root 容器
    const core: CoreServices = {
      events: this.events,
      config: this.config,
      log: this.log,
      metrics: this.metrics,
      health: this.healthService,
      tracer: this.tracer,
      permissions: this.permissions,
      guard: this.guard,
      registry: this.registry,
      scheduler: this.scheduler,
      resolver: this.resolver,
      discovery: this.discovery,
      loader: this.loader,
    };
    registerCoreServices(this.rootContainer, core);
  }

  /** 内核追踪服务（测试/内部）。 */
  get tracing(): TracingService {
    return this.tracer;
  }

  /** 内核根容器（测试/内部）。 */
  get root(): Container {
    return this.rootContainer;
  }

  /** 插件注册表（测试/内部）。 */
  get pluginRegistry(): PluginsRegistry {
    return this.registry;
  }

  /** 解析问题。 */
  get issues(): ReadonlyArray<ResolveIssue> {
    return this.resolveIssues;
  }

  /** 是否已启动。 */
  isStarted(): boolean {
    return this.started;
  }

  /** 上一次启动结果。 */
  get lastStartResult(): KernelStartResult {
    return this.startResult;
  }

  /**
   * 启动内核：发现 → 解析 → 按拓扑序加载与启动。
   */
  async start(): Promise<KernelStartResult> {
    if (this.started) {
      throw new KernelError('E_ALREADY_STARTED', '内核已启动');
    }
    const log = this.log.child('kernel');
    log.info(`内核启动 v${this.version}（契约 v${CONTRACT_VERSION}）`);

    // 0) 配置：插件在 Initialize 阶段就会读配置，因此必须先把各 provider 合并成快照。
    //    不 refresh 的话 initialConfig / 只读默认层对插件不可见（历史缺陷）。
    await this.config.refresh();

    // 1) 发现
    const discovered = await this.discovery.discoverDetailed({
      roots: this.options.roots,
      ...(this.options.builtinRoot
        ? { builtinRoot: this.options.builtinRoot }
        : {}),
      ...(this.options.workspaceRoot
        ? { workspaceRoot: this.options.workspaceRoot }
        : {}),
      legacyFallback: this.options.legacyFallback,
    });

    for (const issue of discovered.issues) {
      log.warn(`发现阶段问题：${issue.dir} - ${issue.message}`);
    }

    // 2) 解析
    const plan = this.resolver.resolve(discovered.candidates, {
      kernelVersion: this.version,
      contractVersion: CONTRACT_VERSION,
      onError: this.options.onResolveError,
    });
    this.resolveIssues = plan.issues;
    for (const issue of plan.issues) {
      const line = `[${issue.code}] ${issue.pluginId}: ${issue.detail}`;
      if (issue.level === 'error') log.error(line);
      else log.warn(line);
    }

    // 3) 按拓扑序加载与启动
    const started: string[] = [];
    const degraded: string[] = [];
    const failed: string[] = [];
    const candidatesById = new Map<string, Candidate>(
      discovered.candidates.map((c) => [c.manifest.id, c]),
    );
    // 软依赖缺失表：启动成功但缺软依赖 → Degraded（而非 Started）。
    const missingOptionalById = new Map<string, string[]>(
      plan.steps.map((s) => [s.candidate.manifest.id, s.missingOptional]),
    );

    for (const pluginId of plan.loadOrder) {
      const candidate = candidatesById.get(pluginId);
      if (!candidate) continue;

      // 硬依赖已失败的插件 → dependency-failed，不启动
      if (this.hasFailedDependency(candidate, failed)) {
        log.warn(`跳过 ${pluginId}：依赖失败（dependency-failed）`);
        failed.push(pluginId);
        continue;
      }

      const outcome = await this.startOnePlugin(candidate, {
        missingOptional: missingOptionalById.get(pluginId) ?? [],
      });
      if (outcome === 'started') started.push(pluginId);
      else if (outcome === 'degraded') degraded.push(pluginId);
      else failed.push(pluginId);
    }

    this.started = true;
    this.startResult = { loadOrder: plan.loadOrder, started, degraded, failed };
    log.info(
      `内核启动完成：started=${started.length} degraded=${degraded.length} failed=${failed.length}`,
    );
    return this.startResult;
  }

  /**
   * 热重载某插件（docs/02 §C.5 热插拔）。
   *
   * 加固语义（相对初版的修正）：
   * 1. 重新发现时带上 workspaceRoot（与 start() 一致）。
   * 2. 对重发现的全量候选重新跑依赖解析；若该插件在新计划中被丢弃（兼容性/依赖变化），
   *    则中止重载并保留 Failed 状态——不允许绕过解析器直接上车。
   * 3. 旧实例停止后**强制**卸载其容器挂载并 dispose 容器、注销权限与健康检查，
   *    不依赖插件自觉调用 `api.unexport`（否则旧导出服务会泄漏在 root 挂载表）。
   * 4. 完成后广播 `kernel.plugin.reloaded`，依赖者可订阅该事件重新解析服务
   *    （依赖者持有的旧服务实例不会被内核替换——这是有意设计：内核不代理插件间调用）。
   */
  async reload(pluginId: string): Promise<void> {
    const loaded = this.registry.getLoaded(pluginId);
    if (!loaded) {
      throw new KernelError('E_GENERIC', `插件未加载，无法重载：${pluginId}`);
    }
    const log = this.log.child(`plugin:${pluginId}`, pluginId);

    // 1) 停止旧实例 + 强制回收
    await this.lifecycle.runStopSequence(
      loaded.instance,
      loaded.context,
      'reload',
    );
    this.teardownPluginArtifacts(loaded);
    this.registry.remove(pluginId);

    // 2) 从磁盘重新发现（与 start() 相同的根集合）
    const rediscovered = await this.discovery.discoverDetailed({
      roots: this.options.roots,
      ...(this.options.builtinRoot
        ? { builtinRoot: this.options.builtinRoot }
        : {}),
      ...(this.options.workspaceRoot
        ? { workspaceRoot: this.options.workspaceRoot }
        : {}),
      legacyFallback: this.options.legacyFallback,
    });
    const candidate = rediscovered.candidates.find(
      (c) => c.manifest.id === pluginId,
    );
    if (!candidate) {
      throw new KernelError('E_GENERIC', `重载失败：未找到插件 ${pluginId}`);
    }

    // 3) 重新解析（兼容性/硬依赖可能已变化）；被丢弃 → Failed
    const plan = this.resolver.resolve(rediscovered.candidates, {
      kernelVersion: this.version,
      contractVersion: CONTRACT_VERSION,
      onError: this.options.onResolveError,
    });
    if (!plan.loadOrder.includes(pluginId)) {
      this.registry.setState(pluginId, PluginState.Failed);
      const issue = plan.issues.find((i) => i.pluginId === pluginId);
      throw new KernelError(
        'E_GENERIC',
        `重载失败：插件在新解析计划中被丢弃（${issue ? `${issue.code}: ${issue.detail}` : '未知原因'}）`,
      );
    }
    const step = plan.steps.find((s) => s.candidate.manifest.id === pluginId);

    // 4) 以新实例重启
    if (!this.startResult.loadOrder.includes(pluginId)) {
      this.startResult.loadOrder.push(pluginId);
    }
    const outcome = await this.startOnePlugin(candidate, {
      loadOptions: { cacheBust: `${Date.now()}-${this.reloadCounter++}` },
      missingOptional: step?.missingOptional ?? [],
    });
    log.info(`热重载完成：${outcome}`);
    await this.events.emit(Topics.PluginReloaded, { pluginId, outcome });
  }

  /**
   * 卸载某插件（Stop → Unload → Dispose → 回收工件）。
   *
   * 级联规则：硬依赖本插件的其他已加载插件会先被递归卸载（依赖者先停）。
   * 幂等：未加载的插件直接返回。
   */
  async unloadPlugin(
    pluginId: string,
    reason: StopReason = 'user-disable',
  ): Promise<void> {
    const loaded = this.registry.getLoaded(pluginId);
    if (!loaded) return;

    // 先卸载所有硬依赖本插件的插件（逆依赖方向级联）。
    const dependents = this.registry
      .allLoaded()
      .filter((p) =>
        Object.keys(p.manifest.dependencies ?? {}).includes(pluginId),
      );
    for (const dependent of dependents) {
      await this.unloadPlugin(dependent.manifest.id, 'dependency-failed');
    }

    const log = this.log.child(`plugin:${pluginId}`, pluginId);
    await this.lifecycle.runStopSequence(
      loaded.instance,
      loaded.context,
      reason,
    );
    this.teardownPluginArtifacts(loaded);
    this.registry.remove(pluginId);

    // 从启动结果中移除（幂等）。
    this.startResult.loadOrder = this.startResult.loadOrder.filter(
      (id) => id !== pluginId,
    );
    this.startResult.started = this.startResult.started.filter(
      (id) => id !== pluginId,
    );
    this.startResult.degraded = this.startResult.degraded.filter(
      (id) => id !== pluginId,
    );
    this.startResult.failed = this.startResult.failed.filter(
      (id) => id !== pluginId,
    );

    log.info('插件已卸载');
    await this.events.emit(Topics.PluginUnloaded, { pluginId, reason });
  }

  /** `unloadPlugin` 的语义别名（用户禁用场景）。 */
  async disablePlugin(pluginId: string): Promise<void> {
    await this.unloadPlugin(pluginId, 'user-disable');
  }

  /**
   * 关闭内核：逆加载序停止全部插件，再清理基础设施。
   */
  async shutdown(): Promise<void> {
    const log = this.log.child('kernel');
    log.info('内核关闭中…');

    const loadedList = this.registry.allLoaded();
    const order = [...this.startResult.loadOrder].reverse();
    const orderedLoaded = [
      ...order
        .map((id) => this.registry.getLoaded(id))
        .filter((p): p is LoadedPlugin => p !== undefined),
      ...loadedList.filter((p) => !order.includes(p.manifest.id)),
    ];

    for (const loaded of orderedLoaded) {
      const reason: StopReason = 'shutdown';
      try {
        await this.lifecycle.runStopSequence(
          loaded.instance,
          loaded.context,
          reason,
        );
        if (
          loaded.state === PluginState.Started ||
          loaded.state === PluginState.Degraded
        ) {
          this.registry.setState(loaded.manifest.id, PluginState.Stopped);
        }
      } catch {
        // 隔离：单个插件停止失败不影响整体关闭。
      }
      this.teardownPluginArtifacts(loaded);
    }

    this.events.clear();
    await this.log.flush();
    await this.tracer.flush();
    this.rootContainer.dispose();
    this.started = false;
    log.info('内核已关闭');
  }

  /**
   * 健康报告。
   */
  async health(): Promise<HealthReport> {
    return await this.healthService.report();
  }

  // ───────────────────────── 内部 ─────────────────────────

  /** 单插件启动选项。 */
  private async startOnePlugin(
    candidate: Candidate,
    opts: { loadOptions?: LoadOptions; missingOptional?: string[] } = {},
  ): Promise<StartOutcome> {
    const pluginId = candidate.manifest.id;
    const log = this.log.child(`plugin:${pluginId}`, pluginId);

    try {
      // 权限：按 source 判定信任级别（可被 options.trustLevel 覆盖）
      const trustLevel: TrustLevel =
        this.options.trustLevel ?? trustLevelFor(candidate.source);
      const decision = this.permissions.check(candidate.manifest, trustLevel);
      for (const w of decision.warnings) {
        log.warn(`权限告警：${w.capability} - ${w.reason}`);
      }

      // 加载
      const loaded = await this.loader.load(candidate, opts.loadOptions ?? {});
      const withPerms: LoadedPlugin = {
        ...loaded,
        permissions: this.permissions.get(pluginId)!,
      };
      this.registry.add(withPerms);
      this.registry.setState(pluginId, PluginState.Loaded);

      // 生命周期启动序列（软依赖缺失 → degraded）
      const outcome = await this.lifecycle.runStartSequence(
        withPerms.instance,
        withPerms.context,
        opts.missingOptional ?? [],
      );

      if (outcome.ok && outcome.degraded) {
        // 启动成功但能力不全（软依赖缺失 / 非致命阶段失败）→ Degraded
        this.registry.setState(pluginId, PluginState.Degraded);
        this.registry.setHealth(pluginId, {
          status: 'degraded',
          message: '软依赖缺失或非致命阶段失败',
          checkedAt: Date.now(),
        });
        if (typeof withPerms.instance.onHealthCheck === 'function') {
          this.healthService.registerCheck(pluginId, () =>
            withPerms.instance.onHealthCheck!(),
          );
        }
        log.warn('插件已降级启动（Degraded）');
        this.metrics
          .counter(KERNEL_METRICS.pluginState, { pluginId, state: 'Degraded' })
          .add(1);
        await this.events.emit(Topics.PluginDegraded, { pluginId });
        return 'degraded';
      }

      if (outcome.ok) {
        this.registry.setState(pluginId, PluginState.Started);
        this.registry.setHealth(pluginId, {
          status: 'healthy',
          checkedAt: Date.now(),
        });
        if (typeof withPerms.instance.onHealthCheck === 'function') {
          this.healthService.registerCheck(pluginId, () =>
            withPerms.instance.onHealthCheck!(),
          );
        }
        log.info('插件已启动');
        this.metrics
          .counter(KERNEL_METRICS.pluginState, { pluginId, state: 'Started' })
          .add(1);
        return 'started';
      }

      // 启动失败：Failed（错误隔离，内核不崩）
      this.registry.setState(pluginId, PluginState.Failed);
      this.registry.setHealth(pluginId, {
        status: 'unhealthy',
        ...(outcome.error ? { message: outcome.error } : {}),
        checkedAt: Date.now(),
      });
      log.error(`插件启动失败（Failed）：${outcome.error ?? '未知错误'}`);
      this.metrics
        .counter(KERNEL_METRICS.pluginState, { pluginId, state: 'Failed' })
        .add(1);
      await this.events.emit(Topics.PluginFailed, {
        pluginId,
        error: outcome.error ?? '未知错误',
      });
      return 'failed';
    } catch (error) {
      this.registry.setState(pluginId, PluginState.Failed);
      log.error(`插件加载/授权失败：${(error as Error).message}`);
      this.metrics
        .counter(KERNEL_METRICS.pluginState, { pluginId, state: 'Failed' })
        .add(1);
      await this.events.emit(Topics.PluginFailed, {
        pluginId,
        error: (error as Error).message,
      });
      return 'failed';
    }
  }

  /**
   * 回收插件工件（不依赖插件自觉清理）：
   * 注销健康检查、撤销权限登记、把插件容器从 root 挂载表卸载并 dispose。
   */
  private teardownPluginArtifacts(loaded: LoadedPlugin): void {
    const pluginId = loaded.manifest.id;
    this.healthService.unregisterCheck(pluginId);
    this.permissions.unregister(pluginId);
    const container = loaded.container as DiContainer;
    this.rootContainer.unmountChildContainer(container);
    container.dispose();
  }

  /** 当前插件阶段（供 context 读取）。 */
  private phaseOf(pluginId: string): LifecyclePhase {
    const loaded = this.registry.getLoaded(pluginId);
    if (!loaded) return 'Discover';
    const map: Record<string, LifecyclePhase> = {
      [PluginState.Discovered]: 'Discover',
      [PluginState.Loaded]: 'Load',
      [PluginState.Configured]: 'Initialize',
      [PluginState.Started]: 'Start',
      [PluginState.Degraded]: 'Degraded',
      [PluginState.Failed]: 'Degraded',
      [PluginState.Stopped]: 'Stop',
      [PluginState.Unloaded]: 'Unload',
      [PluginState.Disposed]: 'Dispose',
    };
    return map[loaded.state] ?? 'Discover';
  }

  /** 硬依赖是否命中失败集合。 */
  private hasFailedDependency(candidate: Candidate, failed: string[]): boolean {
    const deps = Object.keys(candidate.manifest.dependencies ?? {});
    return deps.some((d) => failed.includes(d));
  }
}
