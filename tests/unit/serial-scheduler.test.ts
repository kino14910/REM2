import { describe, expect, it } from 'vitest'

import { SerialScheduler } from '@/kernel/scheduler/serial-scheduler.js'

const noopRelease = (): void => undefined

describe('serial-scheduler · run', () => {
  it('starts tasks in FIFO order', async () => {
    const scheduler = new SerialScheduler()
    const order: number[] = []

    const first = scheduler.run(async () => void order.push(1))
    const second = scheduler.run(async () => void order.push(2))
    const third = scheduler.run(async () => void order.push(3))
    await Promise.all([first, second, third])

    expect(order).toEqual([1, 2, 3])
  })

  it('never runs two tasks at the same time', async () => {
    const scheduler = new SerialScheduler()
    let active = 0
    let peak = 0
    const task = async (): Promise<void> => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
    }

    await Promise.all([
      scheduler.run(task),
      scheduler.run(task),
      scheduler.run(task),
    ])

    expect(peak).toBe(1)
  })

  it('rejects to the caller of a failing task and keeps draining the queue', async () => {
    const scheduler = new SerialScheduler()

    const failing = scheduler.run(async () => {
      throw new Error('boom')
    })
    const succeeding = scheduler.run(async () => 'done')

    await expect(failing).rejects.toThrow('boom')
    await expect(succeeding).resolves.toBe('done')
  })

  it('resolves with the task return value', async () => {
    const scheduler = new SerialScheduler()

    await expect(scheduler.run(async () => 42)).resolves.toBe(42)
  })

  it('accepts a synchronous throwing task', async () => {
    const scheduler = new SerialScheduler()
    const failing = scheduler.run(() => {
      throw new Error('sync boom')
    })

    await expect(failing).rejects.toThrow('sync boom')
  })

  it('reports pending length and the running flag', async () => {
    const scheduler = new SerialScheduler()
    let release: () => void = noopRelease

    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const first = scheduler.run(async () => {
      await gate
    })

    expect(scheduler.isRunning()).toBe(true)
    expect(scheduler.pending()).toBe(0)

    const second = scheduler.run(async () => 2)
    expect(scheduler.pending()).toBe(1)

    release()
    await first
    await second
    expect(scheduler.pending()).toBe(0)

    // The running flag is cleared in the job's `finally`, one microtask after
    // the caller's promise resolves.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(scheduler.isRunning()).toBe(false)
  })

  it('stays idle when nothing was queued', () => {
    const scheduler = new SerialScheduler()

    expect(scheduler.isRunning()).toBe(false)
    expect(scheduler.pending()).toBe(0)
  })
})

describe('serial-scheduler · runAll', () => {
  it('executes sequentially and preserves result order', async () => {
    const scheduler = new SerialScheduler()
    const order: number[] = []

    const results = await scheduler.runAll([
      async () => {
        order.push(1)
        return 'a'
      },
      async () => {
        order.push(2)
        return 'b'
      },
      async () => {
        order.push(3)
        return 'c'
      },
    ])

    expect(results).toEqual(['a', 'b', 'c'])
    expect(order).toEqual([1, 2, 3])
  })

  it('returns an empty array for no tasks', async () => {
    const scheduler = new SerialScheduler()

    await expect(scheduler.runAll([])).resolves.toEqual([])
  })

  it('propagates a failure and stops the remaining tasks', async () => {
    const scheduler = new SerialScheduler()
    const ran: number[] = []

    const run = scheduler.runAll([
      async () => {
        ran.push(1)
      },
      async () => {
        throw new Error('boom')
      },
      async () => {
        ran.push(3)
      },
    ])

    await expect(run).rejects.toThrow('boom')
    expect(ran).toEqual([1])
  })
})
