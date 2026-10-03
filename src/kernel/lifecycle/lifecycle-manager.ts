/**
 * 生命周期管理器（docs/02 §C.1，动机 #4）。
 *
 * 职责：按阶段顺序驱动插件钩子，带超时与回滚；错误隔离（不抛给内核）。
 * 结果通过 `LifecycleOutcome` 返回，由 Kernel 决定插件进入 Started / Degraded / Failed。
 */

import type {
  Plugin,
  LifecyclePhase,
  StopReason,
} from '../contracts/lifecycle.js';
import type { PluginContext } from '../contracts/context.js';
import { PHASES, type PhaseDef } from './phases.js';
import { rollbackPlugin } from './rollback.js';
import { callWithTimeout } from '../util/timeout.js';

/** 单阶段执行记录。 */
export interface PhaseResult {
  phase: LifecyclePhase;
  ok: boolean;
  durationMs: number;
  error?: string;
}

/** 生命周期状态记录（类图 LifecycleState）。 */
export interface LifecycleState {
  pluginId: string;
  phase: LifecyclePhase;
  startedAt: number;
  rolledBack: boolean;
}

/** 启动序列结果。 */
export interface LifecycleOutcome {
  ok: boolean;
  degraded: boolean;
  phaseResults: PhaseResult[];
  error?: string;
  rolledBack: boolean;
}

/** 管理器选项。 */
export interface LifecycleManagerOptions {
  startTimeoutMs: number;
  stopTimeoutMs: number;
  /** 阶段执行前后的观测回调（供指标）。 */
  onPhase?: (
    pluginId: string,
    phase: LifecyclePhase,
    durationMs: number,
    ok: boolean,
  ) => void;
}

/**
 * 生命周期管理器。
 */
export class LifecycleManager {
  private readonly states = new Map<string, LifecycleState>();
  /** 已成功执行过的阶段（用于回滚判定）。 */
  private readonly completedPhases = new Map<string, LifecyclePhase[]>();

  constructor(private readonly opts: LifecycleManagerOptions) {}

  /** 读取某插件的生命周期状态。 */
  getState(pluginId: string): LifecycleState | undefined {
    return this.states.get(pluginId);
  }

  /** 全部状态。 */
  allStates(): LifecycleState[] {
    return Array.from(this.states.values());
  }

  /**
   * 执行启动序列（Discover → Load → Initialize → Start）。
   *
   * 任一 fatal 阶段失败 → 回滚已执行阶段，返回 ok=false（内核据此置 Failed）。
   * 非 fatal 阶段（Discover）失败 → 继续执行，最终标记为 Degraded。
   * 软依赖缺失 → 也标记为 Degraded（由内核在调用前传入 missingOptional 判定）。
   */
  async runStartSequence(
    plugin: Plugin,
    ctx: PluginContext,
    missingOptional: string[] = [],
  ): Promise<LifecycleOutcome> {
    const pluginId = ctx.pluginId;
    const phaseResults: PhaseResult[] = [];
    const completed: LifecyclePhase[] = [];
    let hasNonFatalFailure = false;
    this.states.set(pluginId, {
      pluginId,
      phase: 'Discover',
      startedAt: Date.now(),
      rolledBack: false,
    });

    const startSequence = PHASES.filter(
      (p) =>
        p.phase === 'Discover' ||
        p.phase === 'Load' ||
        p.phase === 'Initialize' ||
        p.phase === 'Start',
    );

    for (const def of startSequence) {
      const result = await this.runPhase(plugin, ctx, def);
      phaseResults.push(result);
      if (result.ok) {
        completed.push(def.phase);
        this.states.set(pluginId, {
          pluginId,
          phase: def.phase,
          startedAt: this.states.get(pluginId)?.startedAt ?? Date.now(),
          rolledBack: false,
        });
      } else if (def.fatal) {
        // 致命失败 → 回滚
        const rb = await rollbackPlugin(plugin, ctx, 'start-failed', {
          stopTimeoutMs: this.opts.stopTimeoutMs,
        });
        this.states.set(pluginId, {
          pluginId,
          phase: def.phase,
          startedAt: this.states.get(pluginId)?.startedAt ?? Date.now(),
          rolledBack: true,
        });
        void rb;
        this.completedPhases.set(pluginId, completed);
        return {
          ok: false,
          degraded: false,
          phaseResults,
          ...(result.error ? { error: result.error } : {}),
          rolledBack: true,
        };
      } else {
        // 非致命失败 → 记录但不回滚，最终进入 Degraded
        hasNonFatalFailure = true;
      }
    }

    this.completedPhases.set(pluginId, completed);
    const degraded = hasNonFatalFailure || missingOptional.length > 0;
    return { ok: true, degraded, phaseResults, rolledBack: false };
  }

  /**
   * 执行停止序列（Stop → Unload → Dispose），幂等。
   */
  async runStopSequence(
    plugin: Plugin,
    ctx: PluginContext,
    reason: StopReason,
  ): Promise<{ ok: boolean; phaseResults: PhaseResult[] }> {
    const pluginId = ctx.pluginId;
    const stopSequence = PHASES.filter(
      (p) =>
        p.phase === 'Stop' || p.phase === 'Unload' || p.phase === 'Dispose',
    );
    const phaseResults: PhaseResult[] = [];

    for (const def of stopSequence) {
      const result = await this.runPhase(plugin, ctx, def, reason);
      phaseResults.push(result);
    }

    this.states.set(pluginId, {
      pluginId,
      phase: 'Dispose',
      startedAt: this.states.get(pluginId)?.startedAt ?? Date.now(),
      rolledBack: this.states.get(pluginId)?.rolledBack ?? false,
    });
    this.completedPhases.delete(pluginId);

    return { ok: phaseResults.every((r) => r.ok), phaseResults };
  }

  /** 运行单个阶段的钩子（带超时）。 */
  private async runPhase(
    plugin: Plugin,
    ctx: PluginContext,
    def: PhaseDef,
    stopReason: StopReason = 'user-disable',
  ): Promise<PhaseResult> {
    const started = Date.now();
    const hook = (plugin as unknown as Record<string, unknown>)[def.hook];

    if (typeof hook !== 'function') {
      // 钩子可选：跳过即视为成功。
      const durationMs = Date.now() - started;
      this.opts.onPhase?.(ctx.pluginId, def.phase, durationMs, true);
      return { phase: def.phase, ok: true, durationMs };
    }

    const timeoutMs =
      def.timeoutKind === 'start'
        ? this.opts.startTimeoutMs
        : def.timeoutKind === 'stop'
          ? this.opts.stopTimeoutMs
          : 0;

    try {
      const fn =
        def.phase === 'Stop'
          ? () =>
              (hook as (c: PluginContext, r: StopReason) => unknown).call(
                plugin,
                ctx,
                stopReason,
              )
          : () => (hook as (c: PluginContext) => unknown).call(plugin, ctx);
      await callWithTimeout(fn, timeoutMs, `${ctx.pluginId} ${def.phase}`);
      const durationMs = Date.now() - started;
      this.opts.onPhase?.(ctx.pluginId, def.phase, durationMs, true);
      return { phase: def.phase, ok: true, durationMs };
    } catch (error) {
      const durationMs = Date.now() - started;
      this.opts.onPhase?.(ctx.pluginId, def.phase, durationMs, false);
      return {
        phase: def.phase,
        ok: false,
        durationMs,
        error: (error as Error).message,
      };
    }
  }
}
