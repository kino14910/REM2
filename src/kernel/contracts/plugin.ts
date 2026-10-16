/**
 * 插件形态契约（纯类型侧）。
 *
 * 唯一形态（docs/03 §3.1）：`export default definePlugin(manifest, setup)`。
 * loader 只需断言 `typeof mod.default === 'function'`，不再做 4 种形态猜测。
 */

import type { PluginContext } from './context.js';
import type { HealthStatus } from './health.js';
import type { StopReason } from './lifecycle.js';

/** 插件钩子集合（全部可选；内核按物理执行序调用）。 */
export type PluginFactoryHooks = {
  /** ① 注册/② 发现：只读探测、声明补充，禁止副作用（无 IO 写、无注册）。 */
  onDiscover?(ctx: PluginContext): Promise<void> | void;
  /** ③ 加载：模块已 import，此阶段只做内存态准备。 */
  onLoad?(ctx: PluginContext): Promise<void> | void;
  /** ④ 初始化：读取配置快照、向子容器注册服务、订阅事件（可回滚）。 */
  onConfigure?(ctx: PluginContext): Promise<void> | void;
  /** ⑥ 配置完成后启动运行时（开连接、起定时器）；必须在 startTimeoutMs 内完成。 */
  onStart?(ctx: PluginContext): Promise<void> | void;
  /** ⑦ 卸载：幂等停止，释放运行时资源。 */
  onStop?(ctx: PluginContext, reason: StopReason): Promise<void> | void;
  /** ⑦ 卸载：注销服务/事件订阅，清空内存态。 */
  onUnload?(ctx: PluginContext): Promise<void> | void;
  /** ⑦ 卸载：最终释放，之后钩子对象不可再被使用。 */
  onDispose?(ctx: PluginContext): Promise<void> | void;
  /** 可选健康自检（经 `health.check` 扩展点暴露）。 */
  onHealthCheck?(): Promise<HealthStatus> | HealthStatus;
};

/** 插件工厂：由 `definePlugin` 产出，loader 在 import 后调用它取得钩子集合。 */
export type PluginFactory = (ctx: PluginContext) => PluginFactoryHooks;

/** 钩子名（`PluginFactoryHooks` 的键，供阶段表穷尽校验）。 */
export type PluginHookName = keyof PluginFactoryHooks;

/** 全部钩子名（有序）。 */
export const PLUGIN_HOOK_NAMES = [
  'onDiscover',
  'onLoad',
  'onConfigure',
  'onStart',
  'onStop',
  'onUnload',
  'onDispose',
  'onHealthCheck',
] as const satisfies readonly PluginHookName[];

/** 插件模块的默认导出形态：唯一形态 = 工厂函数。 */
export type PluginModuleExport = PluginFactory | { default: PluginFactory };
