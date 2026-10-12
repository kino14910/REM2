/**
 * 生命周期管理器：按物理执行序驱动插件钩子，带超时与回滚；错误隔离（不抛给内核）。
 *
 * 驱动的是 `lifecycle/pipeline.ts` 的 `START_PIPELINE` / `STOP_PIPELINE`，
 * 而不是「7 个钩子顺次调一遍」—— 两者的区别在于**状态跃迁点**：
 * 例如 `onLoad` 成功才进入 `Initialized`，`onStart` 成功才进入 `Active`。
 */

import type { LifecyclePhase, StopReason } from '../contracts/lifecycle.js';
import type { PluginFactoryHooks } from '../contracts/plugin.js';
import type { PluginStateT } from '../contracts/plugins.js';
import type { PluginContext } from '../contracts/context.js';
import type { PhaseOutcome } from '../contracts/lifecycle.js';
import { START_PIPELINE, STOP_PIPELINE, type PipelineStep } from './pipeline.js';
import { rollbackHooks } from './rollback.js';
import { callWithTimeout } from '../util/timeout.js';

/** 生命周期状态记录。 */
export interface LifecycleState {
  pluginId: string;
  phase: LifecyclePhase;
  state: PluginStateT;
  startedAt: number;
  rolledBack: boolean;
}

/** 启动序列结果。 */
export interface LifecycleOutcome {
  ok: boolean;
  degraded: boolean;
  phaseResults: PhaseOutcome[];
  error?: string;
  rolledBack: boolean;
  /** 成功走完管线后的状态（`Active` 或 `Degraded`）。 */
  finalState: PluginStateT;
}

/** 管理器选项。 */
export interface LifecycleManagerOptions {
  startTimeoutMs: number;
  stopTimeoutMs: number;
  /** 阶段执行后的观测回调（供指标）。 */
  onPhase?: (
    pluginId: string,
    phase: LifecyclePhase,
    durationMs: number,
    ok: boolean,
  ) => void;
}

export class LifecycleManager {
  private readonly states = new Map<string, LifecycleState>();

  constructor(private readonly opts: LifecycleManagerOptions) {}

  getState(pluginId: string): LifecycleState | undefined {
    return this.states.get(pluginId);
  }

  allStates(): LifecycleState[] {
    return Array.from(this.states.values());
  }

  /**
   * 执行启动管线。
   *
   * 任一 fatal 步骤失败 → 逆序回滚已执行钩子，返回 ok=false（内核据此置 Failed）。
   * 非 fatal 步骤失败 → 继续执行，最终标记为 Degraded。
   * 软依赖缺失 → 同样标记为 Degraded（由 `missingOptional` 传入）。
   */
  async runStartSequence(
    hooks: PluginFactoryHooks,
    ctx: PluginContext,
    missingOptional: string[] = [],
  ): Promise<LifecycleOutcome> {
    const pluginId = ctx.pluginId;
    const phaseResults: PhaseOutcome[] = [];
    const startedAt = Date.now();
    let hasNonFatalFailure = false;
    this.states.set(pluginId, {
      pluginId,
      phase: 'Registered',
      state: 'Loaded',
      startedAt,
      rolledBack: false,
    });

    for (const step of START_PIPELINE) {
      // 纯内核步骤（注册 / 依赖解析 / 装载）由 Kernel 负责，此处只推进状态。
      if (step.hook === null) {
        this.states.set(pluginId, {
          pluginId,
          phase: step.phase,
          state: step.to,
          startedAt,
          rolledBack: false,
        });
        continue;
      }

      const result = await this.runStep(hooks, ctx, step);
      phaseResults.push(result);

      if (result.ok) {
        this.states.set(pluginId, {
          pluginId,
          phase: step.phase,
          state: step.to,
          startedAt,
          rolledBack: false,
        });
        continue;
      }

      if (step.fatal) {
        await rollbackHooks(hooks, ctx, 'start-failed', {
          stopTimeoutMs: this.opts.stopTimeoutMs,
        });
        this.states.set(pluginId, {
          pluginId,
          phase: step.phase,
          state: 'Failed',
          startedAt,
          rolledBack: true,
        });
        return {
          ok: false,
          degraded: false,
          phaseResults,
          ...(result.error !== undefined ? { error: result.error } : {}),
          rolledBack: true,
          finalState: 'Failed',
        };
      }

      hasNonFatalFailure = true;
    }

    const degraded = hasNonFatalFailure || missingOptional.length > 0;
    return {
      ok: true,
      degraded,
      phaseResults,
      rolledBack: false,
      finalState: degraded ? 'Degraded' : 'Active',
    };
  }

  /** 执行停止管线（幂等；单个钩子失败不阻断其余）。 */
  async runStopSequence(
    hooks: PluginFactoryHooks,
    ctx: PluginContext,
    reason: StopReason,
  ): Promise<{ ok: boolean; phaseResults: PhaseOutcome[] }> {
    const pluginId = ctx.pluginId;
    const phaseResults: PhaseOutcome[] = [];
    const startedAt = this.states.get(pluginId)?.startedAt ?? Date.now();

    for (const step of STOP_PIPELINE) {
      phaseResults.push(await this.runStep(hooks, ctx, step, reason));
      this.states.set(pluginId, {
        pluginId,
        phase: step.phase,
        state: step.to,
        startedAt,
        rolledBack: this.states.get(pluginId)?.rolledBack ?? false,
      });
    }

    return { ok: phaseResults.every((r) => r.ok), phaseResults };
  }

  /** 运行单个管线步骤的钩子（带超时）。 */
  private async runStep(
    hooks: PluginFactoryHooks,
    ctx: PluginContext,
    step: PipelineStep,
    stopReason: StopReason = 'user-disable',
  ): Promise<PhaseOutcome> {
    const started = Date.now();
    const hookName = step.hook;
    if (hookName === null) {
      return { pluginId: ctx.pluginId, phase: step.phase, ok: true, durationMs: 0 };
    }

    const hook = hooks[hookName] as
      | ((c: PluginContext, r?: StopReason) => unknown)
      | undefined;

    if (typeof hook !== 'function') {
      // 钩子可选：跳过即视为成功。
      const durationMs = Date.now() - started;
      this.opts.onPhase?.(ctx.pluginId, step.phase, durationMs, true);
      return { pluginId: ctx.pluginId, phase: step.phase, ok: true, durationMs };
    }

    const timeoutMs =
      step.timeoutKind === 'start'
        ? this.opts.startTimeoutMs
        : step.timeoutKind === 'stop'
          ? this.opts.stopTimeoutMs
          : 0;

    try {
      // ★ 必须以 hooks 为接收者调用：钩子既可能是闭包（普通插件的 setup 返回值），
      // 也可能是**类实例**（WorkerPluginProxy 用 this.host 发 RPC）。
      // 无接收者的调用会让后者 `this === undefined` → "Cannot read properties of
      // undefined (reading 'host')"，且只在 worker 插件上出现。
      const fn =
        hookName === 'onStop'
          ? () =>
              (
                hook as (this: unknown, c: PluginContext, r: StopReason) => unknown
              ).call(hooks, ctx, stopReason)
          : hookName === 'onHealthCheck'
            ? () => (hook as (this: unknown) => unknown).call(hooks)
            : () =>
                (hook as (this: unknown, c: PluginContext) => unknown).call(
                  hooks,
                  ctx,
                );
      await callWithTimeout(fn, timeoutMs, `${ctx.pluginId} ${step.phase}`);
      const durationMs = Date.now() - started;
      this.opts.onPhase?.(ctx.pluginId, step.phase, durationMs, true);
      return { pluginId: ctx.pluginId, phase: step.phase, ok: true, durationMs };
    } catch (error) {
      const durationMs = Date.now() - started;
      this.opts.onPhase?.(ctx.pluginId, step.phase, durationMs, false);
      return {
        pluginId: ctx.pluginId,
        phase: step.phase,
        ok: false,
        durationMs,
        error: (error as Error).message,
      };
    }
  }
}
