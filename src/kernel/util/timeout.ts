import { TimeoutError } from '../errors.js'

/**
 * Waits for `promise` within `ms` milliseconds, throwing TimeoutError on expiry.
 *
 * @param promise  the guarded Promise
 * @param ms       timeout in milliseconds (<=0 means no timeout)
 * @param label    label used in the error message
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return await promise
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new TimeoutError(label, ms))
    }, ms)
    if (typeof timer === 'object' && 'unref' in timer) {
      ;(timer as { unref: () => void }).unref()
    }

    promise.then(
      value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export async function callWithTimeout<T>(
  fn: () => Promise<T> | T,
  ms: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return await fn()
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new TimeoutError(label, ms))
    }, ms)
    if (typeof timer === 'object' && 'unref' in timer) {
      ;(timer as { unref: () => void }).unref()
    }

    Promise.resolve()
      .then(fn)
      .then(
        value => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        },
        error => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        },
      )
  })
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer === 'object' && 'unref' in timer) {
      ;(timer as { unref: () => void }).unref()
    }
  })
}
