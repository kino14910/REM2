import { describe, expect, it, vi } from 'vitest'

import type { ServiceToken } from '@/kernel/contracts/service-token.js'

import { PluginApiImpl } from '@/kernel/context/plugin-api.js'
import { defineToken } from '@/kernel/contracts/service-token.js'
import { CapabilityDeniedError } from '@/kernel/errors.js'

const GreeterToken = defineToken<{ greet(): string }>({
  id: 'test.api.greeter',
  describe: 'greeter exported by the plugin',
})

const CounterToken = defineToken<{ value: number }>({
  id: 'test.api.counter',
  describe: 'second service exported by the same plugin',
})

function makeApi(options: { hasExports?: () => boolean } = {}) {
  const container = {
    markExported: vi.fn(),
    markUnexported: vi.fn(),
    hasExports: vi.fn(options.hasExports ?? (() => false)),
    resolve: vi.fn(() => ({ greet: () => 'hi' })),
  }
  const guard = {
    declareServiceCapability: vi.fn(),
    retractServiceCapability: vi.fn(),
    assert: vi.fn(),
  }
  const hooks = { mountExported: vi.fn(), unmountExported: vi.fn() }

  const api = new PluginApiImpl(
    'com.rem2.plugin',
    container as never,
    guard as never,
    hooks,
  )

  return { api, container, guard, hooks }
}

describe('plugin-api · export', () => {
  it('marks the service exported and mounts the container', () => {
    const { api, container, guard, hooks } = makeApi()

    api.export(GreeterToken)

    expect(container.markExported).toHaveBeenCalledWith(GreeterToken)
    expect(hooks.mountExported).toHaveBeenCalledWith(container)
    expect(guard.declareServiceCapability).not.toHaveBeenCalled()
  })

  it('declares the required capability when one is given', () => {
    const { api, guard, hooks } = makeApi()

    api.export(GreeterToken, { capability: 'svc.greet' })

    expect(guard.declareServiceCapability).toHaveBeenCalledWith(
      'test.api.greeter',
      'svc.greet',
    )
    expect(hooks.mountExported).toHaveBeenCalledTimes(1)
  })

  it('does not retract a capability it never declared', () => {
    const { api, guard } = makeApi()

    api.export(GreeterToken)
    api.unexport(GreeterToken)

    expect(guard.retractServiceCapability).toHaveBeenCalledWith(
      'test.api.greeter',
    )
  })
})

describe('plugin-api · unexport', () => {
  it('keeps the container mounted while other exports remain', () => {
    // Two services exported, one still present after the retract.
    const { api, container, hooks } = makeApi({ hasExports: () => true })

    api.export(GreeterToken)
    api.export(CounterToken)
    api.unexport(GreeterToken)

    expect(container.markUnexported).toHaveBeenCalledWith(GreeterToken)
    expect(hooks.unmountExported).not.toHaveBeenCalled()
  })

  it('unmounts the container once the last export is gone', () => {
    const { api, container, hooks } = makeApi({ hasExports: () => false })

    api.export(GreeterToken)
    api.unexport(GreeterToken)

    expect(hooks.unmountExported).toHaveBeenCalledWith(container)
  })
})

describe('plugin-api · useCapability', () => {
  it('resolves the service when the guard allows it', () => {
    const { api, container, guard } = makeApi()

    const resolved = api.useCapability(GreeterToken)

    expect(guard.assert).toHaveBeenCalledWith(
      'test.api.greeter',
      'com.rem2.plugin',
    )
    expect(container.resolve).toHaveBeenCalledWith(GreeterToken)
    expect(resolved.greet()).toBe('hi')
  })

  it('never touches the container when the guard denies', () => {
    const { api, container, guard } = makeApi()
    guard.assert.mockImplementation(() => {
      throw new CapabilityDeniedError('svc.greet', 'com.rem2.plugin')
    })

    expect(() => api.useCapability(GreeterToken)).toThrow(CapabilityDeniedError)
    expect(container.resolve).not.toHaveBeenCalled()
  })

  it('checks the guard before resolving, not after', () => {
    const order: string[] = []
    const { api, guard, container } = makeApi()
    guard.assert.mockImplementation(() => void order.push('assert'))
    container.resolve.mockImplementation(() => {
      order.push('resolve')
      return { greet: () => 'hi' }
    })

    api.useCapability(GreeterToken)

    expect(order).toEqual(['assert', 'resolve'])
  })
})

describe('plugin-api · token identity', () => {
  it('passes the token itself through to both the guard and the container', () => {
    const { api, guard, container } = makeApi()
    const token: ServiceToken<unknown> = CounterToken

    api.export(token)
    api.useCapability(token)

    const assertedId = guard.assert.mock.calls[0]?.[0]
    expect(assertedId).toBe('test.api.counter')
    expect(container.resolve).toHaveBeenCalledWith(token)
  })
})
