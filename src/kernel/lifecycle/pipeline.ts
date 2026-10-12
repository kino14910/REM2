/**
 * 物理执行管线：逻辑状态机 × 物理调用序的映射（docs/11 §4.3）。
 *
 * 内核实际的动作顺序（**依赖解析在物理上排第 2**，尽管逻辑序里它排第 5）：
 *
 * ```
 * A 扫描根目录 discover()
 * B 读 + 校验 plugin.json          → Registered[]
 * C DependencyResolver.resolve(全部) ★ 必须先有 manifest 才知道依赖图
 * D 按拓扑序逐个：权限检查 → resolveEntry → import() → 工厂调用 → 建容器 → Resolved/Loaded
 * E onDiscover → onLoad            → Initialized
 * F onConfigure（读配置快照）       → Configured
 * G onStart                        → Active / Degraded
 * H health 汇总 + KernelReady
 * I 卸载：依赖者先卸载 → onStop → onUnload → onDispose → 强制回收
 * ```
 *
 * 本文件把该顺序表达为**数据**（阶段 + 触发的状态跃迁），
 * 便于 `manager.ts` 统一驱动，也便于测试直接断言「顺序 == 契约」。
 */

import type { LifecyclePhase } from '../contracts/lifecycle.js';
import type { PluginHookName } from '../contracts/plugin.js';
import type { PluginStateT } from '../contracts/plugins.js';

/** 管线步骤的一步。 */
export interface PipelineStep {
  /** 逻辑阶段（驱动 `ctx.phase` 与状态机）。 */
  phase: LifecyclePhase;
  /** 物理动作：调用的插件钩子；`null` 表示纯内核动作（不调插件代码）。 */
  hook: PluginHookName | null;
  /** 该步之后进入的状态。 */
  to: PluginStateT;
  /** 该步之前允许处于的状态；`'*'` 表示任意（停止序列的第一步入边不限）。 */
  from: readonly PluginStateT[] | '*';
  /** 失败是否致命。 */
  fatal: boolean;
  /** 该步的超时来源。 */
  timeoutKind: 'none' | 'start' | 'stop';
}

/** 启动管线（步骤 A–G）。 */
export const START_PIPELINE: ReadonlyArray<PipelineStep> = [
  // B：注册（发现 + 校验）—— 纯内核动作，插件代码尚未被 import。
  {
    phase: 'Registered',
    hook: null,
    from: ['Registered'],
    to: 'Registered',
    fatal: false,
    timeoutKind: 'none',
  },
  // C：依赖解析（内核批量计算）→ Resolved / Dropped。
  {
    phase: 'Resolved',
    hook: null,
    from: ['Registered'],
    to: 'Resolved',
    fatal: false,
    timeoutKind: 'none',
  },
  // D：import() + 工厂调用 + 建容器 → Loaded。
  {
    phase: 'Loaded',
    hook: null,
    from: ['Resolved'],
    to: 'Loaded',
    fatal: true,
    timeoutKind: 'none',
  },
  // E：onDiscover（只读探测）→ Registered 保持。
  {
    phase: 'Registered',
    hook: 'onDiscover',
    from: ['Loaded'],
    to: 'Loaded',
    fatal: false,
    timeoutKind: 'none',
  },
  // E：onLoad（内存态准备）→ Initialized。
  {
    phase: 'Loaded',
    hook: 'onLoad',
    from: ['Loaded'],
    to: 'Initialized',
    fatal: true,
    timeoutKind: 'none',
  },
  // F：onConfigure（读配置快照）→ Configured。
  {
    phase: 'Initialized',
    hook: 'onConfigure',
    from: ['Initialized'],
    to: 'Configured',
    fatal: true,
    timeoutKind: 'none',
  },
  // G：onStart → Active（非致命失败/缺软依赖则 Degraded）。
  {
    phase: 'Configured',
    hook: 'onStart',
    from: ['Configured'],
    to: 'Active',
    fatal: true,
    timeoutKind: 'start',
  },
];

/** 停止管线（步骤 I）：逆序、幂等。 */
export const STOP_PIPELINE: ReadonlyArray<PipelineStep> = [
  {
    phase: 'Stopped',
    hook: 'onStop',
    from: '*',
    to: 'Stopped',
    fatal: false,
    timeoutKind: 'stop',
  },
  {
    phase: 'Unloaded',
    hook: 'onUnload',
    from: ['Stopped'],
    to: 'Unloaded',
    fatal: false,
    timeoutKind: 'stop',
  },
  {
    phase: 'Disposed',
    hook: 'onDispose',
    from: ['Unloaded'],
    to: 'Disposed',
    fatal: false,
    timeoutKind: 'stop',
  },
];

/** 物理序中「插件代码首次被 import」之前的步骤（用于断言依赖解析确实更早）。 */
export const PRE_IMPORT_STEPS: readonly PipelineStep[] = START_PIPELINE.filter(
  (s) => s.hook === null,
);
