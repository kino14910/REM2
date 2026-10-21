/**
 * Serial scheduler (default implementation: same-thread by default to avoid premature worker adoption).
 *
 * Semantics: strict FIFO; the next task starts only after the previous one
 * completes; a task error does not block the queue (it rejects to the caller).
 */

import type { Scheduler, SchedulerTask } from './scheduler.js'

export class SerialScheduler implements Scheduler {
  private queue: Array<() => void> = []
  private running = false

  run<T>(task: SchedulerTask<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job = async (): Promise<void> => {
        try {
          const result = await task()
          resolve(result)
        } catch (error) {
          reject(error as Error)
        }
      }
      this.queue.push(() => {
        void job().finally(() => {
          this.running = false
          void this.pump()
        })
      })
      void this.pump()
    })
  }

  async runAll<T>(tasks: Array<SchedulerTask<T>>): Promise<T[]> {
    const results: T[] = []
    for (const task of tasks) {
      results.push(await this.run(task))
    }
    return results
  }

  pending(): number {
    return this.queue.length
  }

  isRunning(): boolean {
    return this.running
  }

  private async pump(): Promise<void> {
    if (this.running) return
    const next = this.queue.shift()
    if (!next) return
    this.running = true
    next()
  }
}
