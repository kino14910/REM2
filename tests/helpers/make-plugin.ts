/**
 * 测试辅助：构造内存插件（唯一形态 = 工厂函数），记录钩子调用。
 */

import { defineToken } from 'rem2-kernel';
import type {
  HealthStatus,
  PluginContext,
  PluginFactoryHooks,
  ServiceToken,
  StopReason,
} from 'rem2-kernel';
import { makeManifest, type MakeManifestOptions } from './make-manifest.js';

/** 钩子调用记录。 */
export interface HookLog {
  hook: string;
  phase: string;
  reason?: StopReason;
}

/** makePlugin 选项。 */
export interface MakePluginOptions extends MakeManifestOptions {
  /** onStart 行为：正常 / 抛错 / 挂起（触发超时）。 */
  startBehavior?: 'ok' | 'throw' | { throw: string } | { delayMs: number };
  /** onConfigure 行为。 */
  configureBehavior?: 'ok' | { throw: string };
  /** 健康状态。 */
  health?: HealthStatus;
  /** 自定义 onStart 回调（覆盖上面的行为）。 */
  onStart?: (ctx: PluginContext) => void | Promise<void>;
  /** 共享的钩子日志数组。 */
  log?: HookLog[];
}

/** 便捷：创建名为 id 的服务令牌。 */
export function tokenFor<T>(id: string): ServiceToken<T> {
  return defineToken<T>({ id, describe: id });
}

/**
 * 创建一个内存插件的钩子集合。
 *
 * 注意：工厂形态下 manifest 由 `plugin.json` 提供，内联 manifest 只作辅助断言用，
 * 因此这里返回 `PluginFactoryHooks`（不含 manifest 字段）。
 */
export function makePlugin(opts: MakePluginOptions): PluginFactoryHooks {
  const manifest = makeManifest(opts);
  const hookLog = opts.log ?? [];

  const record = (hook: string, phase: string, reason?: StopReason): void => {
    hookLog.push(reason ? { hook, phase, reason } : { hook, phase });
  };

  return {
    async onDiscover(): Promise<void> {
      record('onDiscover', 'Registered');
    },

    async onLoad(): Promise<void> {
      record('onLoad', 'Loaded');
    },

    async onConfigure(): Promise<void> {
      record('onConfigure', 'Initialized');
      if (opts.configureBehavior && opts.configureBehavior !== 'ok') {
        throw new Error(opts.configureBehavior.throw);
      }
    },

    async onStart(ctx: PluginContext): Promise<void> {
      record('onStart', 'Configured');
      if (opts.onStart) {
        await opts.onStart(ctx);
        return;
      }
      const behavior = opts.startBehavior ?? 'ok';
      if (behavior === 'throw') {
        throw new Error(`${manifest.id} 启动失败`);
      }
      if (typeof behavior === 'object' && 'throw' in behavior) {
        throw new Error(behavior.throw);
      }
      if (typeof behavior === 'object' && 'delayMs' in behavior) {
        await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
      }
    },

    async onStop(_ctx: PluginContext, reason: StopReason): Promise<void> {
      record('onStop', 'Stopped', reason);
    },

    async onUnload(): Promise<void> {
      record('onUnload', 'Unloaded');
    },

    async onDispose(): Promise<void> {
      record('onDispose', 'Disposed');
    },

    onHealthCheck(): HealthStatus {
      return opts.health ?? 'healthy';
    },
  };
}
