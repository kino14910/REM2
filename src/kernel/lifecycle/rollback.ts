/**
 * 回滚策略（docs/02 §C.1：部分启动失败必须回滚已执行的钩子）。
 *
 * 回滚顺序：Dispose → Unload → Stop（逆序释放），且每个钩子带超时、彼此隔离。
 */

import type { Plugin } from '../contracts/lifecycle.js';
import type { PluginContext } from '../contracts/context.js';
import type { StopReason } from '../contracts/lifecycle.js';
import { callWithTimeout } from '../util/timeout.js';

/** 回滚选项。 */
export interface RollbackOptions {
  stopTimeoutMs: number;
}

/** 回滚结果。 */
export interface RollbackResult {
  ok: boolean;
  errors: Array<{ hook: string; message: string }>;
}

/**
 * 逆序执行 onStop → onUnload → onDispose（幂等），吞掉单个钩子错误。
 */
export async function rollbackPlugin(
  plugin: Plugin,
  ctx: PluginContext,
  reason: StopReason,
  opts: RollbackOptions,
): Promise<RollbackResult> {
  const errors: Array<{ hook: string; message: string }> = [];

  const steps: Array<{ hook: string; run: () => Promise<void> | void }> = [];
  if (typeof plugin.onDispose === 'function') {
    steps.push({ hook: 'onDispose', run: () => plugin.onDispose!(ctx) });
  }
  if (typeof plugin.onUnload === 'function') {
    steps.push({ hook: 'onUnload', run: () => plugin.onUnload!(ctx) });
  }
  if (typeof plugin.onStop === 'function') {
    steps.push({ hook: 'onStop', run: () => plugin.onStop!(ctx, reason) });
  }

  for (const step of steps) {
    try {
      await callWithTimeout(
        step.run,
        opts.stopTimeoutMs,
        `${ctx.pluginId} 回滚 ${step.hook}`,
      );
    } catch (error) {
      errors.push({ hook: step.hook, message: (error as Error).message });
    }
  }

  return { ok: errors.length === 0, errors };
}
