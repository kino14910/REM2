/**
 * Scheduler contract: the scheduler is a kernel facility that plugins may replace.
 *
 * The kernel ships the default serial implementation (SerialScheduler);
 * process isolation or parallel scheduling can be provided by a Scheduler plugin.
 */

/** A schedulable task. */
export type SchedulerTask<T> = () => Promise<T> | T

export interface Scheduler {
  /** Runs a task serially (tasks in the same queue never run concurrently). */
  run<T>(task: SchedulerTask<T>): Promise<T>
  /** Runs a set of tasks in parallel. */
  runAll<T>(tasks: Array<SchedulerTask<T>>): Promise<T[]>
  /** Current queue length. */
  pending(): number
  /** Whether a task is currently running. */
  isRunning(): boolean
}
