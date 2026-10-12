/**
 * Worker 插件代理（内核侧视图）。
 *
 * 对 `LifecycleManager` / `PluginsRegistry` 而言，代理就是一个普通的
 * `PluginFactoryHooks` 对象：钩子经 RPC 转发到 Worker 线程中的真实插件，
 * Worker 侧使用自己的简化版上下文（见 `worker-bootstrap.ts`）。
 *
 * 另承载 Worker 侧的扩展点贡献（docs/11 §6.2）：仅 log.sink / metrics.sink /
 * trace.exporter 三类，值必须可结构化克隆。贡献由 Worker 内 ctx 的
 * `extensions.contribute` 经 RPC 转发到内核的 `ExtensionPointRegistry`。
 */

import type { PluginFactoryHooks } from '../contracts/plugin.js';
import type { StopReason } from '../contracts/lifecycle.js';
import type { WorkerPluginHost } from './worker-host.js';
import { WORKER_ALLOWED_EXTENSION_POINTS } from './worker-protocol.js';

/** Worker 可贡献的扩展点集合（供 `worker-bootstrap` 与本文件共用同一份定义）。 */
export const WORKER_CONTRIBUTABLE_POINTS: ReadonlySet<string> = new Set(
  WORKER_ALLOWED_EXTENSION_POINTS,
);

export class WorkerPluginProxy implements PluginFactoryHooks {
  constructor(private readonly host: WorkerPluginHost) {}

  // 钩子参数中的 PluginContext 无法跨结构化克隆传输，因此 Worker 侧使用自己构建的代理上下文；
  // 这里只把可序列化的附加参数（如 StopReason）传过去。

  async onDiscover(): Promise<void> {
    await this.host.callHook('onDiscover', []);
  }
  async onLoad(): Promise<void> {
    await this.host.callHook('onLoad', []);
  }
  async onConfigure(): Promise<void> {
    await this.host.callHook('onConfigure', []);
  }
  async onStart(): Promise<void> {
    await this.host.callHook('onStart', []);
  }
  async onStop(_ctx: unknown, reason: StopReason): Promise<void> {
    await this.host.callHook('onStop', [reason]);
  }  async onUnload(): Promise<void> {
    await this.host.callHook('onUnload', []);
  }
  async onDispose(): Promise<void> {
    await this.host.callHook('onDispose', []);
    // 终止 Worker 线程。
    await this.host.terminate();
  }
  async onHealthCheck(): Promise<'healthy' | 'degraded' | 'unhealthy'> {
    const value = await this.host.callHook('onHealthCheck', []);
    const valid = value as string | undefined;
    if (valid === 'healthy' || valid === 'degraded' || valid === 'unhealthy') {
      return valid;
    }
    return 'unhealthy';
  }
}
