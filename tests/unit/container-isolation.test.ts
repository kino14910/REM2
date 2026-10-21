import { describe, expect, it } from 'vitest'
import { Container } from '../../src/kernel/di/container.js'
import { defineToken } from '../../src/kernel/contracts/service-token.js'
import { NoProviderError } from '../../src/kernel/errors.js'

interface Svc {
  value: number
}

const Exported = defineToken<Svc>({
  id: 'qa.svc.exported',
  describe: 'qa exported',
})
const Unexported = defineToken<Svc>({
  id: 'qa.svc.unexported',
  describe: 'qa unexported',
})

function makeRoot(): Container {
  // The kernel root container is shareable=true (public facilities stay visible to child containers).
  return new Container({ scope: 'root', shareable: true })
}

describe('container-isolation · the parent reference is invisible', () => {
  it('the child container does not expose the parent container reference via public properties', () => {
    const root = makeRoot()
    const child = root.createChild('plugin:a')
    const raw = child as unknown as Record<string, unknown>

    expect(raw.parent).toBeUndefined()
    expect(raw.parentContainer).toBeUndefined()
    expect(raw.parentRef).toBeUndefined()
    // Only a boolean check is exposed.
    expect(child.hasParent).toBe(true)
    expect(typeof child.hasParent).toBe('boolean')
  })
})

describe('container-isolation · export visibility', () => {
  it('the parent container cannot resolve a service not exported by the child container', () => {
    const root = makeRoot()
    const child = root.createChild('plugin:a')
    child.registerInstance(Unexported, { value: 1 })

    expect(() => root.resolve(Unexported)).toThrow(NoProviderError)
  })

  it('after export and reverse mounting, the parent container can resolve the child container service', () => {
    const root = makeRoot()
    const child = root.createChild('plugin:a')
    child.registerInstance(Exported, { value: 7 })
    child.markExported(Exported)
    root.mountChildContainer(child) // equivalent to the reverse mounting performed by api.export()

    expect(root.resolve(Exported).value).toBe(7)
  })

  it('after unexport the parent container no longer resolves that service', () => {
    const root = makeRoot()
    const child = root.createChild('plugin:a')
    child.registerInstance(Exported, { value: 7 })
    child.markExported(Exported)
    root.mountChildContainer(child)
    expect(root.resolve(Exported).value).toBe(7)

    child.markUnexported(Exported)
    root.unmountChildContainer(child)
    expect(() => root.resolve(Exported)).toThrow(NoProviderError)
  })

  it('the plugin child container cannot resolve a parent service that is neither shared nor exported', () => {
    const root = new Container({ scope: 'root', shareable: false })
    root.registerInstance(Unexported, { value: 1 })
    const child = new Container({
      scope: 'plugin:a',
      parent: root,
      pluginScope: true,
    })
    expect(() => child.resolve(Unexported)).toThrow(NoProviderError)
  })
})

describe('container-isolation · sibling plugin exports (the foundation of useCapability)', () => {
  it('after a sibling plugin exports via root, its child container can resolve that service', () => {
    const root = makeRoot()
    const provider = root.createChild('plugin:provider')
    const consumer = root.createChild('plugin:consumer')

    provider.registerInstance(Exported, { value: 9 })
    provider.markExported(Exported)
    root.mountChildContainer(provider) // reverse mounting as performed by api.export()

    // Design promise: a plugin can resolve services exported by other plugins.
    expect(consumer.resolve(Exported).value).toBe(9)
  })
})
