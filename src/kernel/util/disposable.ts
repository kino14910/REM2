/**
 * 可处置资源集合（docs/02 §C.1 幂等停止/回滚）。
 */

/** 可处置对象。 */
export interface Disposable {
  dispose(): void | Promise<void>;
}

/**
 * 可处置集合：按注册逆序释放，且整体幂等（重复 dispose 只执行一次）。
 */
export class DisposableStore implements Disposable {
  private readonly items: Disposable[] = [];
  private disposed = false;

  /** 添加一个可处置项；若已 dispose，则立即处置该项并返回。 */
  add(item: Disposable): void {
    if (this.disposed) {
      void Promise.resolve(item.dispose()).catch(() => undefined);
      return;
    }
    this.items.push(item);
  }

  /** 添加一个纯函数清理项。 */
  addFn(fn: () => void | Promise<void>): void {
    this.add({ dispose: fn });
  }

  /** 逆序释放全部；单个失败不阻断其余。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const reversed = [...this.items].reverse();
    this.items.length = 0;
    for (const item of reversed) {
      try {
        await item.dispose();
      } catch {
        // 忽略单个释放错误，保证继续释放。
      }
    }
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get size(): number {
    return this.items.length;
  }
}

/** 由多个清理回调构造一个 Disposable。 */
export function disposableFrom(
  ...fns: Array<() => void | Promise<void>>
): Disposable {
  return {
    async dispose(): Promise<void> {
      for (const fn of [...fns].reverse()) {
        try {
          await fn();
        } catch {
          // 忽略，继续。
        }
      }
    },
  };
}
