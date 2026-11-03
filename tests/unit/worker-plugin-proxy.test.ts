import { describe, expect, it, vi } from 'vitest'

import type { WorkerPluginHost } from '@/kernel/isolation/worker-host.js'

import { WorkerPluginProxy } from '@/kernel/isolation/worker-plugin-proxy.js'

type HookCall = [hook: string, args: unknown[]]

function makeProxy(result: unknown = undefined): {
  proxy: WorkerPluginProxy
  calls: HookCall[]
  terminate: ReturnType<typeof vi.fn>
} {
  const calls: HookCall[] = []
  const host = {
    pluginId: 'com.rem2.worker',
    callHook: vi.fn(async (hook: string, args: unknown[] = []) => {
      calls.push([hook, args])
      return result
    }),
    terminate: vi.fn(async () => undefined),
  }

  return {
    proxy: new WorkerPluginProxy(host as unknown as WorkerPluginHost),
    calls,
    terminate: host.terminate,
  }
}

describe('worker-plugin-proxy · hook forwarding', () => {
  it('forwards each lifecycle hook under its own name with no arguments', async () => {
    const { proxy, calls } = makeProxy()

    await proxy.onDiscover?.()
    await proxy.onLoad?.()
    await proxy.onConfigure?.()
    await proxy.onStart?.()
    await proxy.onUnload?.()

    expect(calls.map(([hook]) => hook)).toEqual([
      'onDiscover',
      'onLoad',
      'onConfigure',
      'onStart',
      'onUnload',
    ])
    expect(calls.every(([, args]) => args.length === 0)).toBe(true)
  })

  it('passes the stop reason through to the worker', async () => {
    const { proxy, calls } = makeProxy()

    await proxy.onStop?.({} as never, 'reload')

    expect(calls).toEqual([['onStop', ['reload']]])
  })

  it('terminates the worker after onDispose', async () => {
    const { proxy, calls, terminate } = makeProxy()

    await proxy.onDispose?.()

    expect(calls).toEqual([['onDispose', []]])
    expect(terminate).toHaveBeenCalledTimes(1)
  })
})

describe('worker-plugin-proxy · health check validation', () => {
  it.each(['healthy', 'degraded', 'unhealthy'] as const)(
    'accepts the %s verdict from the worker',
    async verdict => {
      const { proxy } = makeProxy(verdict)

      await expect(proxy.onHealthCheck()).resolves.toBe(verdict)
    },
  )

  it('maps an unrecognised verdict to unhealthy', async () => {
    const { proxy } = makeProxy('fine-thanks')

    await expect(proxy.onHealthCheck()).resolves.toBe('unhealthy')
  })

  it('maps a missing verdict to unhealthy', async () => {
    const { proxy } = makeProxy(undefined)

    await expect(proxy.onHealthCheck()).resolves.toBe('unhealthy')
  })
})
