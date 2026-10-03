/**
 * 超时工具（docs/02 §C.1：每个生命周期钩子带超时）。
 */

import { TimeoutError } from '../errors.js';

/**
 * 在 `ms` 毫秒内等待 `promise`，超时则抛 TimeoutError。
 *
 * @param promise  被守护的 Promise
 * @param ms       超时毫秒（<=0 表示不超时）
 * @param label    错误信息标签
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return await promise;
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TimeoutError(label, ms));
    }, ms);
    if (typeof timer === 'object' && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 把同步/异步函数包成带超时保护的调用。 */
export async function callWithTimeout<T>(
  fn: () => Promise<T> | T,
  ms: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return await fn();
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TimeoutError(label, ms));
    }, ms);
    if (typeof timer === 'object' && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }

    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

/** 简单延迟。 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === 'object' && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
  });
}
