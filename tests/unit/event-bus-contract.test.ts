import { describe, expect, it, vi } from 'vitest'

import { EventBusImpl } from '@/kernel/events/event-bus.js'

describe('event-bus · once cleanup', () => {
  it('removes the subscription after a successful call', async () => {
    const bus = new EventBusImpl()
    const handler = vi.fn()

    bus.once('job:done', handler)
    await bus.emit('job:done')
    await bus.emit('job:done')

    expect(handler).toHaveBeenCalledTimes(1)
    expect(bus.size()).toBe(0)
  })

  it('removes the subscription even when the handler throws', async () => {
    const bus = new EventBusImpl()
    const handler = vi.fn(() => {
      throw new Error('once boom')
    })

    bus.once('job:done', handler)
    await bus.emit('job:done')
    await bus.emit('job:done')

    expect(handler).toHaveBeenCalledTimes(1)
    expect(bus.size()).toBe(0)
  })
})

describe('event-bus · off', () => {
  it('removes only the matching listener from a shared bucket', async () => {
    const bus = new EventBusImpl()
    const first = vi.fn()
    const second = vi.fn()

    bus.on('job:done', first)
    bus.on('job:done', second)
    bus.off('job:done', first)
    await bus.emit('job:done')

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect(bus.size()).toBe(1)
  })

  it('leaves other patterns in the same bucket alone', async () => {
    const bus = new EventBusImpl()
    const exact = vi.fn()
    const wildcard = vi.fn()

    bus.on('job:done', exact)
    bus.on('job:*', wildcard)
    bus.off('job:done', exact)
    await bus.emit('job:done')

    expect(exact).not.toHaveBeenCalled()
    expect(wildcard).toHaveBeenCalledTimes(1)
  })
})

describe('event-bus · responder priority', () => {
  it('picks the earliest registered responder for a topic', async () => {
    const bus = new EventBusImpl()

    bus.respond('calc:add', () => 'first')
    bus.respond('calc:add', () => 'second')

    await expect(bus.request('calc:add')).resolves.toBe('first')
  })

  it('falls back to the next responder after the first is unsubscribed', async () => {
    const bus = new EventBusImpl()
    const unsubscribeFirst = bus.respond('calc:add', () => 'first')
    bus.respond('calc:add', () => 'second')

    unsubscribeFirst()

    await expect(bus.request('calc:add')).resolves.toBe('second')
  })

  it('ignores responders registered for other topics', async () => {
    const bus = new EventBusImpl()
    bus.respond('calc:sub', () => 'sub')

    await expect(bus.request('calc:add')).rejects.toThrow(/no responder/)
  })
})

describe('event-bus · clear', () => {
  it('drops both subscriptions and responders', async () => {
    const bus = new EventBusImpl()
    const handler = vi.fn()
    bus.on('job:done', handler)
    bus.respond('calc:add', () => 'first')

    bus.clear()

    expect(bus.size()).toBe(0)
    await bus.emit('job:done')
    expect(handler).not.toHaveBeenCalled()
    await expect(bus.request('calc:add')).rejects.toThrow(/no responder/)
  })
})

describe('event-bus · dispatch snapshot', () => {
  it('a listener removed mid-dispatch still runs in that dispatch', async () => {
    // Documented contract: subscribe/unsubscribe during a dispatch does not
    // affect that dispatch. `off()` only drops the bucket entry; the snapshot
    // taken by emit() keeps the original subscription object.
    const bus = new EventBusImpl()
    const order: string[] = []
    const second = vi.fn(() => void order.push('second'))

    bus.on('job:done', () => {
      order.push('first')
      bus.off('job:done', second)
    })
    bus.on('job:done', second)

    await bus.emit('job:done')

    expect(order).toEqual(['first', 'second'])
    expect(second).toHaveBeenCalledTimes(1)

    // The removal does apply to the next dispatch.
    order.length = 0
    await bus.emit('job:done')
    expect(order).toEqual(['first'])
  })

  it('a listener added mid-dispatch does not run in that dispatch', async () => {
    const bus = new EventBusImpl()
    const late = vi.fn()

    bus.on('job:done', () => {
      bus.on('job:done', late)
    })

    await bus.emit('job:done')
    expect(late).not.toHaveBeenCalled()

    await bus.emit('job:done')
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('a once listener removed by an earlier listener never runs', async () => {
    // The snapshot check `sub.removed` covers the once case: the unsubscribe
    // returned by once() goes through removeSubscription(), which flips the
    // flag that emit() re-checks before each call.
    const bus = new EventBusImpl()
    const onceHandler = vi.fn()
    let unsubscribe: () => void = () => undefined

    bus.on('job:done', () => unsubscribe())
    unsubscribe = bus.once('job:done', onceHandler)

    await bus.emit('job:done')

    expect(onceHandler).not.toHaveBeenCalled()
  })
})
