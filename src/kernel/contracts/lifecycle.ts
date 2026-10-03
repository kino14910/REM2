/**
 * 生命周期契约（纯类型）。见 docs/02 §C.1。
 */

import type { PluginManifest } from './manifest.js';
import type { PluginContext } from './context.js';
import type { HealthStatus } from './health.js';

/** 生命周期阶段名（显式，非字符串魔法 —— 动机 #4）。 */
export type LifecyclePhase =
  | 'Discover'
  | 'Load'
  | 'Initialize'
  | 'Start'
  | 'Stop'
  | 'Unload'
  | 'Dispose'
  /** 内部降级态（非正常阶段，用于状态机表达）。 */
  | 'Degraded';

/** 停止/失败原因，决定回滚路径。 */
export type StopReason =
  | 'user-disable'
  | 'reload'
  | 'dependency-failed'
  | 'health-degraded'
  | 'shutdown'
  | 'start-failed'
  | 'timeout';

/**
 * 插件实例契约：所有钩子可选；内核按阶段顺序调用。
 *
 * 钩子与阶段的映射：
 * - Discover  → onDiscover（只读，禁止副作用）
 * - Load      → onLoad
 * - Initialize→ onConfigure
 * - Start     → onStart
 * - Stop      → onStop(ctx, reason)
 * - Unload    → onUnload
 * - Dispose   → onDispose
 */
export interface Plugin {
  readonly manifest: PluginManifest;

  /** 1. Discover：只做只读探测/声明补充，禁止副作用（无 IO 写、无注册）。 */
  onDiscover?(ctx: PluginContext): Promise<void> | void;

  /** 2. Load：模块已实例化，此阶段只做内存态准备。 */
  onLoad?(ctx: PluginContext): Promise<void> | void;

  /** 3. Initialize：读取配置、向 DI 容器注册服务、订阅事件（可回滚）。 */
  onConfigure?(ctx: PluginContext): Promise<void> | void;

  /** 4. Start：启动运行时（开连接、起定时器、挂 UI），必须在 startTimeoutMs 内完成。 */
  onStart?(ctx: PluginContext): Promise<void> | void;

  /** 5. Stop：幂等停止，释放运行时资源。 */
  onStop?(ctx: PluginContext, reason: StopReason): Promise<void> | void;

  /** 6. Unload：注销服务/事件订阅，清空内存态。 */
  onUnload?(ctx: PluginContext): Promise<void> | void;

  /** 7. Dispose：最终释放，之后实例不可再被使用。 */
  onDispose?(ctx: PluginContext): Promise<void> | void;

  /** 可选的健康自检：由 HealthService 周期性调用。 */
  onHealthCheck?(): Promise<HealthStatus> | HealthStatus;
}

/** 插件模块的默认导出形态（loader 兼容「类」或「实例」两种导出）。 */
export type PluginModuleExport =
  | Plugin
  | (new () => Plugin)
  | { default: Plugin | (new () => Plugin) };
