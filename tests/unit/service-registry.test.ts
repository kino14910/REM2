import { describe, expect, it } from 'vitest'

import { defineToken } from '@/kernel/contracts/service-token.js'
import { Container } from '@/kernel/di/container.js'
import { Lifetime } from '@/kernel/di/lifetime.js'
import { ServiceRegistryFacade } from '@/kernel/di/service-registry.js'
import { NoProviderError } from '@/kernel/errors.js'

interface Greeter {
  greet(name: string): string
}

const GreeterToken = defineToken<Greeter>({
  id: 'test.registry.greeter',
  describe: 'greeter for registry tests',
})

const CounterToken = defineToken<{ value: number }>({
  id: 'test.registry.counter',
  describe: 'counter for registry tests',
})

function makeFacade(): ServiceRegistryFacade {
  return new ServiceRegistryFacade(new Container({ scope: 'root' }))
}

describe('service-registry · register and resolve', () => {
  it('resolves a factory-registered service', () => {
    const registry = makeFacade()
    registry.register(GreeterToken, () => ({
      greet: name => `hi ${name}`,
    }))

    expect(registry.resolve(GreeterToken).greet('rem2')).toBe('hi rem2')
  })

  it('resolves a registered instance as-is', () => {
    const registry = makeFacade()
    const instance: Greeter = { greet: name => `yo ${name}` }
    registry.registerInstance(GreeterToken, instance)

    expect(registry.resolve(GreeterToken)).toBe(instance)
  })

  it('honours the lifetime argument', () => {
    const registry = makeFacade()
    let built = 0
    registry.register(
      CounterToken,
      () => {
        built += 1
        return { value: built }
      },
      Lifetime.Transient,
    )

    const first = registry.resolve(CounterToken)
    const second = registry.resolve(CounterToken)

    expect(first).not.toBe(second)
    expect(built).toBe(2)
  })

  it('throws when resolving an unregistered token', () => {
    const registry = makeFacade()

    expect(() => registry.resolve(GreeterToken)).toThrow(NoProviderError)
  })

  it('returns this from register calls so calls can chain', () => {
    const registry = makeFacade()

    const returned = registry
      .register(GreeterToken, () => ({ greet: () => 'x' }))
      .registerInstance(CounterToken, { value: 1 })

    expect(returned).toBe(registry)
  })
})

describe('service-registry · lookups', () => {
  it('tryResolve returns undefined instead of throwing', () => {
    const registry = makeFacade()

    expect(registry.tryResolve(GreeterToken)).toBeUndefined()

    registry.registerInstance(GreeterToken, { greet: () => 'x' })
    expect(registry.tryResolve(GreeterToken)).toBeDefined()
  })

  it('has reflects registration', () => {
    const registry = makeFacade()
    expect(registry.has(GreeterToken)).toBe(false)

    registry.registerInstance(GreeterToken, { greet: () => 'x' })

    expect(registry.has(GreeterToken)).toBe(true)
  })

  it('list reports registered token ids', () => {
    const registry = makeFacade()
    registry.registerInstance(GreeterToken, { greet: () => 'x' })

    expect(registry.list()).toContain('test.registry.greeter')
  })
})
