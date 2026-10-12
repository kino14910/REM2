/**
 * 生命周期契约（纯类型）。
 *
 * 阶段名按 docs/11 §4.2 的状态机重命名：`ctx.phase` 反映的是**逻辑状态机当前位置**，
 * 而非「内核正在调用哪个钩子」——两者由 `lifecycle/pipeline.ts` 做映射。
 */

/**
 * 生命周期阶段（= 逻辑状态机的可观测阶段子集）。
 *
 * `Degraded` 不是正常阶段，而是「启动成功但能力不全」的降级态。
 */
export type LifecyclePhase =
  | 'Registered'
  | 'Resolved'
  | 'Loaded'
  | 'Initialized'
  | 'Configured'
  | 'Active'
  | 'Degraded'
  | 'Stopped'
  | 'Unloaded'
  | 'Disposed';

/** 停止/失败原因，决定回滚路径。 */
export type StopReason =
  | 'user-disable'
  | 'reload'
  | 'dependency-failed'
  | 'health-degraded'
  | 'shutdown'
  | 'start-failed'
  | 'timeout';

/** 单阶段执行结果。 */
export interface PhaseOutcome {
  /** 所属插件。 */
  pluginId: string;
  /** 阶段名。 */
  phase: LifecyclePhase;
  ok: boolean;
  durationMs: number;
  error?: string;
}
