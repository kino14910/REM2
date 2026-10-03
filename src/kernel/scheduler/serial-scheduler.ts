/**
 * 串行调度器（默认实现，docs/02 §E.1：默认同线程，避免过早引入 worker）。
 *
 * 语义：FIFO 串行；每个任务完成后才启动下一个；任务错误不阻断队列（reject 给调用方）。
 */

import type { Scheduler, SchedulerTask } from './scheduler.js';

/**
 * 串行调度器。
 */
export class SerialScheduler implements Scheduler {
  private queue: Array<() => void> = [];
  private running = false;

  run<T>(task: SchedulerTask<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job = async (): Promise<void> => {
        try {
          const result = await task();
          resolve(result);
        } catch (error) {
          reject(error as Error);
        }
      };
      this.queue.push(() => {
        void job().finally(() => {
          this.running = false;
          void this.pump();
        });
      });
      void this.pump();
    });
  }

  async runAll<T>(tasks: Array<SchedulerTask<T>>): Promise<T[]> {
    const results: T[] = [];
    for (const task of tasks) {
      results.push(await this.run(task));
    }
    return results;
  }

  pending(): number {
    return this.queue.length;
  }

  isRunning(): boolean {
    return this.running;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    this.running = true;
    next();
  }
}
