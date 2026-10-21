import { describe, expect, it } from 'vitest'
import { Container } from '../../src/kernel/di/container.js'
import { defineToken } from '../../src/kernel/contracts/service-token.js'
import { Lifetime } from '../../src/kernel/di/lifetime.js'
import {
  CircularDependencyError,
  NoProviderError,
} from '../../src/kernel/errors.js'

interface Greeter {
  greet(name: string): string
}

const GreeterToken = defineToken<Greeter>({
  id: 'test.greeter',
  describe: 'test Greeter',
})

describe('DI · Container', () => {
  it('a singleton instantiates only once', () => {
    const c = new Container({ scope: 'root' })
    let count = 0
    c.register(
      GreeterToken,
      () => {
        count += 1
        return { greet: (n: string) => `hi ${n}` }
      },
      Lifetime.Singleton,
    )
    const a = c.resolve(GreeterToken)
    const b = c.resolve(GreeterToken)
    expect(a).toBe(b)
    expect(count).toBe(1)
  })

  it('a transient creates a new instance each time', () => {
    const c = new Container({ scope: 'root' })
    let count = 0
    c.register(
      GreeterToken,
      () => {
        count += 1
        return { greet: (n: string) => `hi ${n}` }
      },
      Lifetime.Transient,
    )
    c.resolve(GreeterToken)
    c.resolve(GreeterToken)
    expect(count).toBe(2)
  })

  it('registerInstance returns the instance directly', () => {
    const c = new Container({ scope: 'root' })
    const inst: Greeter = { greet: n => `hi ${n}` }
    c.registerInstance(GreeterToken, inst)
    expect(c.resolve(GreeterToken)).toBe(inst)
  })

  it('an unregistered service throws NoProviderError', () => {
    const c = new Container({ scope: 'root' })
    expect(() => c.resolve(GreeterToken)).toThrow(NoProviderError)
    expect(c.tryResolve(GreeterToken)).toBeUndefined()
  })

  it('the child container can resolve public (root shareable) services from the parent', () => {
    const root = new Container({ scope: 'root', shareable: true })
    root.registerInstance(GreeterToken, { greet: n => `hi ${n}` })
    const child = root.createChild('plugin:a')
    expect(child.resolve(GreeterToken).greet('x')).toBe('hi x')
  })

  it('the plugin child container cannot resolve a service not exported by the parent', () => {
    const root = new Container({ scope: 'root' })
    root.registerInstance(GreeterToken, { greet: n => `hi ${n}` }) // not exported, not shareable
    const child = new Container({
      scope: 'plugin:a',
      parent: root,
      pluginScope: true,
    })
    expect(() => child.resolve(GreeterToken)).toThrow(NoProviderError)
  })

  it('after export, the plugin child container can resolve the parent container service', () => {
    const root = new Container({ scope: 'root' })
    root.registerInstance(GreeterToken, { greet: n => `hi ${n}` })
    root.markExported(GreeterToken)
    const child = new Container({
      scope: 'plugin:a',
      parent: root,
      pluginScope: true,
    })
    expect(child.resolve(GreeterToken)).toBeDefined()
  })

  it('a circular dependency throws CircularDependencyError', () => {
    const root = new Container({ scope: 'root' })
    const A = defineToken<unknown>({ id: 'a', describe: 'a' })
    const B = defineToken<unknown>({ id: 'b', describe: 'b' })
    root.register(A, c => (c as Container).resolve(B), Lifetime.Singleton)
    root.register(B, c => (c as Container).resolve(A), Lifetime.Singleton)
    expect(() => root.resolve(A)).toThrow(CircularDependencyError)
  })

  it('has / list behave correctly', () => {
    const c = new Container({ scope: 'root' })
    expect(c.has(GreeterToken)).toBe(false)
    c.registerInstance(GreeterToken, { greet: () => 'x' })
    expect(c.has(GreeterToken)).toBe(true)
    expect(c.list()).toContain('test.greeter')
  })

  it("dispose calls the instance's dispose", () => {
    const c = new Container({ scope: 'root' })
    let disposed = false
    c.registerInstance(GreeterToken, {
      greet: () => 'x',
      dispose: () => {
        disposed = true
      },
    } as Greeter & { dispose: () => void })
    c.dispose()
    expect(disposed).toBe(true)
  })

  it('plugins must not access the parent container reference (hasParent returns only a boolean)', () => {
    const root = new Container({ scope: 'root' })
    const child = root.createChild('plugin:a')
    expect(child.hasParent).toBe(true)
    // no public parent property
    expect(
      (child as unknown as { parentRef?: unknown }).parentRef,
    ).toBeUndefined()
  })
})
