/**
 * 测试辅助：构造内存插件实例（实现 Plugin 接口），记录钩子调用。
 */

import {
  ServiceToken,
  type HealthStatus,
  type Plugin,
  type PluginContext,
  type StopReason,
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
  return ServiceToken.create<T>({ id, describe: id });
}

/**
 * 创建一个内存插件实例。
 */
export function makePlugin(opts: MakePluginOptions): Plugin {
  const manifest = makeManifest(opts);
  const hookLog = opts.log ?? [];

  const record = (hook: string, phase: string, reason?: StopReason): void => {
    hookLog.push(reason ? { hook, phase, reason } : { hook, phase });
  };

  const plugin: Plugin = {
    manifest,

    async onDiscover(): Promise<void> {
      record('onDiscover', 'Discover');
    },

    async onLoad(): Promise<void> {
      record('onLoad', 'Load');
    },

    async onConfigure(): Promise<void> {
      record('onConfigure', 'Initialize');
      if (opts.configureBehavior && opts.configureBehavior !== 'ok') {
        throw new Error(opts.configureBehavior.throw);
      }
    },

    async onStart(ctx: PluginContext): Promise<void> {
      record('onStart', 'Start');
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
      record('onStop', 'Stop', reason);
    },

    async onUnload(): Promise<void> {
      record('onUnload', 'Unload');
    },

    async onDispose(): Promise<void> {
      record('onDispose', 'Dispose');
    },

    onHealthCheck(): HealthStatus {
      return opts.health ?? 'healthy';
    },
  };

  return plugin;
}
