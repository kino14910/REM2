import { describe, expect, it, vi } from 'vitest'

import { DisposableStore, disposableFrom } from '@/kernel/util/disposable.js'

describe('disposable · DisposableStore', () => {
  it('releases items in reverse registration order', async () => {
    const order: number[] = []
    const store = new DisposableStore()
    store.addFn(() => void order.push(1))
    store.addFn(() => void order.push(2))
    store.addFn(() => void order.push(3))

    await store.dispose()

    expect(order).toEqual([3, 2, 1])
  })

  it('awaits each async disposer before starting the next', async () => {
    const order: string[] = []
    const store = new DisposableStore()
    store.addFn(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      order.push('slow')
    })
    store.addFn(() => void order.push('fast'))

    await store.dispose()

    expect(order).toEqual(['fast', 'slow'])
  })

  it('is idempotent: a repeated dispose runs nothing', async () => {
    const fn = vi.fn()
    const store = new DisposableStore()
    store.addFn(fn)

    await store.dispose()
    await store.dispose()

    expect(fn).toHaveBeenCalledTimes(1)
    expect(store.isDisposed).toBe(true)
  })

  it('a throwing item does not block the remaining items', async () => {
    const order: string[] = []
    const store = new DisposableStore()
    store.addFn(() => void order.push('first'))
    store.addFn(() => {
      throw new Error('boom')
    })
    store.addFn(() => void order.push('last'))

    await expect(store.dispose()).resolves.toBeUndefined()

    expect(order).toEqual(['last', 'first'])
  })

  it('disposes an item added after dispose immediately', async () => {
    const fn = vi.fn()
    const store = new DisposableStore()
    await store.dispose()

    store.addFn(fn)
    await Promise.resolve()

    expect(fn).toHaveBeenCalledTimes(1)
    expect(store.size).toBe(0)
  })

  it('drops the item list once disposed', async () => {
    const store = new DisposableStore()
    store.addFn(() => undefined)
    store.addFn(() => undefined)
    expect(store.size).toBe(2)

    await store.dispose()

    expect(store.size).toBe(0)
  })
})

describe('disposable · disposableFrom', () => {
  it('runs the callbacks in reverse order', async () => {
    const order: number[] = []
    const disposable = disposableFrom(
      () => void order.push(1),
      () => void order.push(2),
    )

    await disposable.dispose()

    expect(order).toEqual([2, 1])
  })

  it('swallows a callback error and keeps going', async () => {
    const order: string[] = []
    const disposable = disposableFrom(
      () => void order.push('a'),
      () => {
        throw new Error('boom')
      },
      () => void order.push('c'),
    )

    await expect(disposable.dispose()).resolves.toBeUndefined()

    expect(order).toEqual(['c', 'a'])
  })
})
