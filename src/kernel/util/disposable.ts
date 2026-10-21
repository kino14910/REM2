export interface Disposable {
  dispose(): void | Promise<void>
}

/**
 * Disposable collection: releases in reverse registration order and is idempotent
 * as a whole (a repeated dispose runs once).
 */
export class DisposableStore implements Disposable {
  private readonly items: Disposable[] = []
  private disposed = false

  /** Adds a disposable; if already disposed, the item is disposed immediately. */
  add(item: Disposable): void {
    if (this.disposed) {
      void Promise.resolve(item.dispose()).catch(() => undefined)
      return
    }
    this.items.push(item)
  }

  addFn(fn: () => void | Promise<void>): void {
    this.add({ dispose: fn })
  }

  /** Disposes everything in reverse order; one failure does not block the rest. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const reversed = [...this.items].reverse()
    this.items.length = 0
    for (const item of reversed) {
      try {
        await item.dispose()
      } catch {
        // Ignore individual dispose errors so the rest still run.
      }
    }
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  get size(): number {
    return this.items.length
  }
}

export function disposableFrom(
  ...fns: Array<() => void | Promise<void>>
): Disposable {
  return {
    async dispose(): Promise<void> {
      for (const fn of [...fns].reverse()) {
        try {
          await fn()
        } catch {
          // Ignore and continue.
        }
      }
    },
  }
}
