/**
 * 回滚策略：致命失败时逆序释放已执行的钩子。
 *
 * 顺序：onDispose → onUnload → onStop（逆序），每个带超时、彼此隔离。
 */

import type { PluginFactoryHooks } from '../contracts/plugin.js';
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

/** 逆序执行 onStop → onUnload → onDispose（幂等），吞掉单个钩子错误。 */
export async function rollbackHooks(
  hooks: PluginFactoryHooks,
  ctx: PluginContext,
  reason: StopReason,
  opts: RollbackOptions,
): Promise<RollbackResult> {
  const errors: Array<{ hook: string; message: string }> = [];

  const steps: Array<{ hook: string; run: () => Promise<void> | void }> = [];
  if (typeof hooks.onDispose === 'function') {
    steps.push({ hook: 'onDispose', run: () => hooks.onDispose!(ctx) });
  }
  if (typeof hooks.onUnload === 'function') {
    steps.push({ hook: 'onUnload', run: () => hooks.onUnload!(ctx) });
  }
  if (typeof hooks.onStop === 'function') {
    steps.push({ hook: 'onStop', run: () => hooks.onStop!(ctx, reason) });
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
