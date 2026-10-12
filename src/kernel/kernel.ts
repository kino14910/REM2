/**
 * 内核编排层：发现 → 解析 → 按拓扑序加载与驱动生命周期 → 回收。
 *
 * 变更（docs/13 C16）：构造器**只接收注入的 `KernelDeps`**，不再 `new` 任何实现类；
 * 全部装配在 `composition.ts`。因此本文件与 `composition.ts` 是全仓库仅有的两个装配点
 * （docs/13 §3.3 D7 的例外）。
 *
 * 物理执行序见 `lifecycle/pipeline.ts`；注意依赖解析在**物理上先于**任何插件代码加载。
 */

import { KERNEL_VERSION, CONTRACT_VERSION } from './version.js';
import type { KernelDeps } from './composition.js';
import { createDeps } from './composition.js';
import type { KernelOptions } from './bootstrap/options.js';
import { Container } from './di/container.js';
import { KERNEL_METRICS } from './contracts/metrics.js';
import { KernelError } from './errors.js';
import { Topics } from './topics.js';
import type { KernelStartResult } from './state-machine.js';
import type { LoadedPlugin } from './extensions/ports-types.js';
import type { Candidate } from './discovery/candidate.js';
import type { HealthReport } from './contracts/health.js';
import type { StopReason } from './contracts/lifecycle.js';
import type { TrustLevel } from './contracts/permission.js';
import { trustLevelFor } from './security/trust-policy.js';
import type { LoadOptions } from './loader/loader.js';
import type { ResolveIssue } from './dependency/resolver.js';

/** 单插件启动结果。 */
type StartOutcome = 'started' | 'degraded' | 'failed';

export class Kernel {
  readonly id: string;
  readonly version = KERNEL_VERSION;
  readonly options: KernelOptions;

  private readonly deps: KernelDeps;

  private started = false;
  private reloadCounter = 0;
  private startResult: KernelStartResult = {
    loadOrder: [],
    started: [],
    degraded: [],
    failed: [],
    dropped: [],
  };

  /**
   * @param partial 选项（内部转交 `createDeps` 装配），或直接注入完整 `KernelDeps`。
   */
  constructor(partial: Partial<KernelOptions> | KernelDeps = {}) {
    this.deps = isKernelDeps(partial) ? partial : createDeps(partial);
    this.options = this.deps.options;
    this.id = this.options.id;
  }

  /** 内核追踪服务（测试/内部）。 */
  get tracing(): KernelDeps['tracer'] {
    return this.deps.tracer;
  }

  /** 内核根容器（测试/内部）。 */
  get root(): Container {
    return this.deps.rootContainer;
  }

  /** 插件注册表（测试/内部）。 */
  get pluginRegistry(): KernelDeps['registry'] {
    return this.deps.registry;
  }

  /** 扩展点注册表（宿主注册 UI 相关默认实现时使用）。 */
  get extensions(): KernelDeps['extensions'] {
    return this.deps.extensions;
  }

  /** 解析问题。 */
  get issues(): ReadonlyArray<ResolveIssue> {
    return this.deps.resolveIssues();
  }

  isStarted(): boolean {
    return this.started;
  }

  get lastStartResult(): KernelStartResult {
    return this.startResult;
  }

  /**
   * 启动内核：发现 → 解析 → 按拓扑序加载与启动。
   *
   * 物理序（docs/11 §4.3）：配置快照 → 发现 → 依赖解析 → 逐个加载并驱动生命周期。
   */
  async start(): Promise<KernelStartResult> {
    if (this.started) {
      throw new KernelError('E_ALREADY_STARTED', '内核已启动');
    }
    const log = this.deps.log.child('kernel');
    log.info(`内核启动 v${this.version}（契约 v${CONTRACT_VERSION}）`);

    // 0) 配置：插件在 Initialize 阶段就会读配置，必须先把各 provider 合并成快照。
    await this.deps.config.refresh();

    // 1) 发现（B：读 + 校验 plugin.json → Registered[]）
    const discovered = await this.deps.discovery.discoverDetailed({
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
    // 2) 依赖解析（C：物理上必须在此刻完成 —— 要先有 manifest 才知道依赖图）
    const plan = this.deps.planOf(discovered.candidates);
    for (const issue of plan.issues) {
      const line = `[${issue.code}] ${issue.pluginId}: ${issue.detail}`;
      if (issue.level === 'error') log.error(line);
      else log.warn(line);
    }

    // 3) 按拓扑序加载与启动（D–G）
    const started: string[] = [];
    const degraded: string[] = [];
    const failed: string[] = [];
    const candidatesById = new Map<string, Candidate>(
      discovered.candidates.map((c) => [c.manifest.id, c]),
    );
    const missingOptionalById = new Map<string, string[]>(
      plan.steps.map((s) => [s.candidate.manifest.id, s.missingOptional]),
    );

    for (const pluginId of plan.loadOrder) {
      const candidate = candidatesById.get(pluginId);
      if (!candidate) continue;

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
    this.startResult = {
      loadOrder: plan.loadOrder,
      started,
      degraded,
      failed,
      dropped: plan.dropped,
    };
    log.info(
      `内核启动完成：started=${started.length} degraded=${degraded.length} failed=${failed.length} dropped=${plan.dropped.length}`,
    );
    await this.deps.events.emit(Topics.KernelReady, {
      loadOrder: plan.loadOrder,
      started,
      degraded,
      failed,
    });
    return this.startResult;
  }

  /** 热重载某插件：停止 → 强制回收 → 重新发现 → 重新解析 → 重启。 */
  async reload(pluginId: string): Promise<void> {
    const loaded = this.deps.registry.getLoaded(pluginId);
    if (!loaded) {
      throw new KernelError('E_GENERIC', `插件未加载，无法重载：${pluginId}`);
    }
    const log = this.deps.log.child(`plugin:${pluginId}`, pluginId);

    await this.deps.lifecycle.runStopSequence(
      loaded.hooks,
      loaded.context,
      'reload',
    );
    this.teardownPluginArtifacts(loaded);
    this.deps.registry.remove(pluginId);

    const rediscovered = await this.deps.discovery.discoverDetailed({
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

    // 重新解析：兼容性/硬依赖可能已变化；被丢弃 → Failed（不允许绕过解析器上车）。
    const plan = this.deps.planOf(rediscovered.candidates);
    if (!plan.loadOrder.includes(pluginId)) {
      this.deps.registry.setState(pluginId, 'Failed');
      const issue = plan.issues.find((i) => i.pluginId === pluginId);
      throw new KernelError(
        'E_GENERIC',
        `重载失败：插件在新解析计划中被丢弃（${issue ? `${issue.code}: ${issue.detail}` : '未知原因'}）`,
      );
    }
    const step = plan.steps.find((s) => s.candidate.manifest.id === pluginId);

    if (!this.startResult.loadOrder.includes(pluginId)) {
      this.startResult.loadOrder.push(pluginId);
    }
    const outcome = await this.startOnePlugin(candidate, {
      loadOptions: { cacheBust: `${Date.now()}-${this.reloadCounter++}` },
      missingOptional: step?.missingOptional ?? [],
    });
    log.info(`热重载完成：${outcome}`);
    await this.deps.events.emit(Topics.PluginReloaded, { pluginId, outcome });
  }

  /**
   * 卸载某插件（Stop → Unload → Dispose → 回收工件）。
   *
   * 级联：硬依赖本插件的其他已加载插件先被递归卸载。幂等：未加载直接返回。
   */
  async unloadPlugin(
    pluginId: string,
    reason: StopReason = 'user-disable',
  ): Promise<void> {
    const loaded = this.deps.registry.getLoaded(pluginId);
    if (!loaded) return;

    const dependents = this.deps.registry
      .allLoaded()
      .filter((p) =>
        Object.keys(p.manifest.dependencies ?? {}).includes(pluginId),
      );
    for (const dependent of dependents) {
      await this.unloadPlugin(dependent.manifest.id, 'dependency-failed');
    }

    const log = this.deps.log.child(`plugin:${pluginId}`, pluginId);
    await this.deps.lifecycle.runStopSequence(loaded.hooks, loaded.context, reason);
    this.teardownPluginArtifacts(loaded);
    this.deps.registry.remove(pluginId);

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
    await this.deps.events.emit(Topics.PluginUnloaded, { pluginId, reason });
  }

  /** `unloadPlugin` 的语义别名（用户禁用场景）。 */
  async disablePlugin(pluginId: string): Promise<void> {
    await this.unloadPlugin(pluginId, 'user-disable');
  }

  /** 关闭内核：逆加载序停止全部插件，再清理基础设施。 */
  async shutdown(): Promise<void> {
    const log = this.deps.log.child('kernel');
    log.info('内核关闭中…');

    const order = [...this.startResult.loadOrder].reverse();
    const orderedLoaded = [
      ...order
        .map((id) => this.deps.registry.getLoaded(id))
        .filter((p): p is LoadedPlugin => p !== undefined),
      ...this.deps.registry
        .allLoaded()
        .filter((p) => !order.includes(p.manifest.id)),
    ];

    for (const loaded of orderedLoaded) {
      try {
        await this.deps.lifecycle.runStopSequence(
          loaded.hooks,
          loaded.context,
          'shutdown',
        );
        if (loaded.state === 'Active' || loaded.state === 'Degraded') {
          this.deps.registry.setState(loaded.manifest.id, 'Stopped');
        }
      } catch {
        // 隔离：单个插件停止失败不影响整体关闭。
      }
      this.teardownPluginArtifacts(loaded);
    }

    this.deps.events.clear();
    await this.deps.log.flush();
    await this.deps.tracer.flush();
    this.deps.rootContainer.dispose();
    this.started = false;
    log.info('内核已关闭');
  }

  async health(): Promise<HealthReport> {
    return await this.deps.health.report();
  }

  // ───────────────────────── 内部 ─────────────────────────

  private async startOnePlugin(
    candidate: Candidate,
    opts: { loadOptions?: LoadOptions; missingOptional?: string[] } = {},
  ): Promise<StartOutcome> {
    const pluginId = candidate.manifest.id;
    const log = this.deps.log.child(`plugin:${pluginId}`, pluginId);

    try {
      // 权限：按 source 判定信任级别（可被 options.trustLevel 覆盖）
      const trustLevel: TrustLevel =
        this.options.trustLevel ?? trustLevelFor(candidate.source);
      const decision = this.deps.permissions.check(candidate.manifest, trustLevel);
      for (const w of decision.warnings) {
        log.warn(`权限告警：${w.capability} - ${w.reason}`);
      }

      const loaded = await this.deps.loader.load(
        candidate,
        opts.loadOptions ?? {},
      );
      const withPerms: LoadedPlugin = {
        ...loaded,
        permissions:
          this.deps.permissions.get(pluginId) ?? loaded.permissions,
      };
      this.deps.registry.add(withPerms);
      this.deps.registry.setState(pluginId, 'Loaded');

      const outcome = await this.deps.lifecycle.runStartSequence(
        withPerms.hooks,
        withPerms.context,
        opts.missingOptional ?? [],
      );

      if (outcome.ok && outcome.degraded) {
        this.deps.registry.setState(pluginId, 'Degraded');
        this.deps.registry.setHealth(pluginId, {
          status: 'degraded',
          message: '软依赖缺失或非致命阶段失败',
          checkedAt: Date.now(),
        });
        this.registerHealthCheck(withPerms);
        log.warn('插件已降级启动（Degraded）');
        this.deps.metrics
          .counter(KERNEL_METRICS.pluginState, { pluginId, state: 'Degraded' })
          .add(1);
        await this.deps.events.emit(Topics.PluginDegraded, { pluginId });
        return 'degraded';
      }

      if (outcome.ok) {
        this.deps.registry.setState(pluginId, outcome.finalState);
        this.deps.registry.setHealth(pluginId, {
          status: 'healthy',
          checkedAt: Date.now(),
        });
        this.registerHealthCheck(withPerms);
        log.info('插件已启动');
        this.deps.metrics
          .counter(KERNEL_METRICS.pluginState, { pluginId, state: 'Active' })
          .add(1);
        return 'started';
      }

      this.deps.registry.setState(pluginId, 'Failed');
      this.deps.registry.setHealth(pluginId, {
        status: 'unhealthy',
        ...(outcome.error ? { message: outcome.error } : {}),
        checkedAt: Date.now(),
      });
      log.error(`插件启动失败（Failed）：${outcome.error ?? '未知错误'}`);
      this.deps.metrics
        .counter(KERNEL_METRICS.pluginState, { pluginId, state: 'Failed' })
        .add(1);
      await this.deps.events.emit(Topics.PluginFailed, {
        pluginId,
        error: outcome.error ?? '未知错误',
      });
      return 'failed';
    } catch (error) {
      this.deps.registry.setState(pluginId, 'Failed');
      log.error(`插件加载/授权失败：${(error as Error).message}`);
      this.deps.metrics
        .counter(KERNEL_METRICS.pluginState, { pluginId, state: 'Failed' })
        .add(1);
      await this.deps.events.emit(Topics.PluginFailed, {
        pluginId,
        error: (error as Error).message,
      });
      return 'failed';
    }
  }

  /**
   * 插件健康自检经 `health.check` 扩展点暴露（不再直接调 `registerCheck`）。
   * 未实现 `onHealthCheck` 的插件不贡献。
   */
  private registerHealthCheck(loaded: LoadedPlugin): void {
    const check = loaded.hooks.onHealthCheck;
    if (typeof check !== 'function') return;
    this.deps.extensions.contribute(loaded.manifest.id, 'health.check', {
      contributionId: loaded.manifest.id,
      impl: () => check.call(loaded.hooks),
    });
  }

  /**
   * 回收插件工件（不依赖插件自觉清理，P6）：
   * 撤回扩展点贡献 → 注销健康检查 → 撤销权限 → 卸载并 dispose 容器。
   */
  private teardownPluginArtifacts(loaded: LoadedPlugin): void {
    const pluginId = loaded.manifest.id;
    this.deps.extensions.retractAll(pluginId);
    this.deps.health.unregisterCheck(pluginId);
    this.deps.permissions.unregister(pluginId);
    const container = loaded.container as Container;
    this.deps.rootContainer.unmountChildContainer(container);
    container.dispose();
  }

  private hasFailedDependency(candidate: Candidate, failed: string[]): boolean {
    const deps = Object.keys(candidate.manifest.dependencies ?? {});
    return deps.some((d) => failed.includes(d));
  }
}

/** 判定入参是完整 `KernelDeps` 还是 `KernelOptions`。 */
function isKernelDeps(value: Partial<KernelOptions> | KernelDeps): value is KernelDeps {
  return (
    typeof value === 'object' &&
    value !== null &&
    'rootContainer' in value &&
    'lifecycle' in value &&
    'extensions' in value
  );
}
