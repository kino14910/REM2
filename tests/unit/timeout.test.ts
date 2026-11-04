import { describe, expect, it } from 'vitest'

import { TimeoutError } from '@/kernel/errors.js'
import { callWithTimeout, delay, withTimeout } from '@/kernel/util/timeout.js'

describe('timeout · withTimeout', () => {
  it('resolves with the promise value when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50, 'op')).resolves.toBe(
      'ok',
    )
  })

  it('rejects with TimeoutError carrying the label and duration', async () => {
    const never = new Promise<string>(() => undefined)

    const failure = withTimeout(never, 20, 'slow-op')

    await expect(failure).rejects.toBeInstanceOf(TimeoutError)
    await expect(failure).rejects.toThrow(
      /operation timed out: slow-op \(20ms\)/,
    )
  })

  it('passes a non-positive timeout through without arming a timer', async () => {
    await expect(
      withTimeout(
        delay(5).then(() => 'done'),
        0,
        'op',
      ),
    ).resolves.toBe('done')
    await expect(
      withTimeout(Promise.resolve(1), Number.POSITIVE_INFINITY, 'op'),
    ).resolves.toBe(1)
  })

  it('propagates the original rejection instead of a timeout', async () => {
    const boom = Promise.reject(new Error('inner failure'))

    await expect(withTimeout(boom, 50, 'op')).rejects.toThrow('inner failure')
  })

  it('ignores a value that arrives after the timeout fired', async () => {
    let release: (value: string) => void = () => undefined
    const late = new Promise<string>(resolve => {
      release = resolve
    })

    const failure = withTimeout(late, 10, 'late-op')
    await expect(failure).rejects.toBeInstanceOf(TimeoutError)

    release('too late')
    await expect(failure).rejects.toBeInstanceOf(TimeoutError)
  })
})

describe('timeout · callWithTimeout', () => {
  it('resolves with the function result', async () => {
    await expect(callWithTimeout(() => 'sync', 50, 'fn')).resolves.toBe('sync')
    await expect(callWithTimeout(async () => 'async', 50, 'fn')).resolves.toBe(
      'async',
    )
  })

  it('rejects with TimeoutError when the function outlives the budget', async () => {
    const slow = (): Promise<string> => delay(100).then(() => 'late')

    await expect(callWithTimeout(slow, 10, 'slow-fn')).rejects.toBeInstanceOf(
      TimeoutError,
    )
  })

  it('runs the function directly when the timeout is disabled', async () => {
    await expect(callWithTimeout(() => 'no-budget', 0, 'fn')).resolves.toBe(
      'no-budget',
    )
  })

  it('propagates a synchronous throw from the function', async () => {
    await expect(
      callWithTimeout(
        () => {
          throw new Error('sync boom')
        },
        50,
        'fn',
      ),
    ).rejects.toThrow('sync boom')
  })

  it('propagates an asynchronous rejection', async () => {
    await expect(
      callWithTimeout(
        async () => {
          throw new Error('async boom')
        },
        50,
        'fn',
      ),
    ).rejects.toThrow('async boom')
  })
})

describe('timeout · delay', () => {
  it('resolves only after the requested delay', async () => {
    const started = Date.now()

    await delay(20)

    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
  })
})
