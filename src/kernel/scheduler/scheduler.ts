/**
 * 调度器契约（docs/02 §B.6：Scheduler 是可被插件替换的内核设施）。
 *
 * 内核提供默认串行实现（SerialScheduler），进程隔离/并行调度可由 Scheduler 插件替换。
 */

/** 调度任务。 */
export type SchedulerTask<T> = () => Promise<T> | T;

/**
 * 调度器。
 */
export interface Scheduler {
  /** 串行执行任务（保证同一队列内任务不并发）。 */
  run<T>(task: SchedulerTask<T>): Promise<T>;
  /** 并行执行一组任务。 */
  runAll<T>(tasks: Array<SchedulerTask<T>>): Promise<T[]>;
  /** 当前队列长度。 */
  pending(): number;
  /** 正在执行中。 */
  isRunning(): boolean;
}
