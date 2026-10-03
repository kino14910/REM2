/**
 * Worker 插件代理（内核侧视图）。
 *
 * 对内核其余部分（LifecycleManager、Registry）而言，WorkerPluginProxy 就是一个
 * 普通的 `Plugin` 实例。它的生命周期钩子通过 RPC 转发到 Worker 线程中的真实插件，
 * Worker 线程使用自己的简化版上下文（见 worker-bootstrap.ts）。
 */

import type { Plugin, StopReason } from '../contracts/lifecycle.js';
import type { PluginContext } from '../contracts/context.js';
import type { PluginManifest } from '../contracts/manifest.js';
import type { WorkerPluginHost } from './worker-host.js';

export class WorkerPluginProxy implements Plugin {
  readonly manifest: PluginManifest;

  constructor(
    manifest: PluginManifest,
    private readonly host: WorkerPluginHost,
  ) {
    this.manifest = manifest;
  }

  // 钩子参数中的 PluginContext 无法跨结构化克隆传输，因此 Worker 侧使用自己构建的代理上下文；
  // 这里只把可序列化的附加参数（如 StopReason）传过去。

  async onDiscover(_ctx: PluginContext): Promise<void> {
    await this.host.callHook('onDiscover', []);
  }
  async onLoad(_ctx: PluginContext): Promise<void> {
    await this.host.callHook('onLoad', []);
  }
  async onConfigure(_ctx: PluginContext): Promise<void> {
    await this.host.callHook('onConfigure', []);
  }
  async onStart(_ctx: PluginContext): Promise<void> {
    await this.host.callHook('onStart', []);
  }
  async onStop(_ctx: PluginContext, reason: StopReason): Promise<void> {
    await this.host.callHook('onStop', [reason]);
  }
  async onUnload(_ctx: PluginContext): Promise<void> {
    await this.host.callHook('onUnload', []);
  }
  async onDispose(_ctx: PluginContext): Promise<void> {
    await this.host.callHook('onDispose', []);
    // 终止 Worker 线程。
    await this.host.terminate();
  }
  async onHealthCheck(): Promise<'healthy' | 'degraded' | 'unhealthy'> {
    const value = await this.host.callHook('onHealthCheck', []);
    const valid = value as string | undefined;
    if (valid === 'healthy' || valid === 'degraded' || valid === 'unhealthy')
      return valid;
    return 'unhealthy';
  }
}
