/**
 * Key invariants:
 * 1. The parent container reference is private; plugins cannot obtain a parent container handle through the public API (cross-boundary access protection).
 *    Only `hasParent: boolean` is exposed.
 * 2. Parent container services are not resolvable by child containers by default; only after the parent declares a service public/shareable
 *    via `markExported(token)` (or `shareable: true`) can children resolve it.
 * 3. singleton/scoped cache their instance and call `dispose()` on it at dispose time (if implemented).
 * 4. Resolution performs cycle detection (construction stack) and throws CircularDependencyError.
 */

import type { Container as ContainerContract } from '../contracts/container.js'
import type {
  ServiceToken,
  ServiceFactory,
} from '../contracts/service-token.js'
import { Lifetime, normalizeLifetime } from './lifetime.js'
import { CircularDependencyError, NoProviderError } from '../errors.js'
import type { ServiceRegistry } from '../contracts/service.js'

interface Registration<T = unknown> {
  token: ServiceToken<T>
  factory: ServiceFactory<T> | null
  instance: T | undefined
  hasInstance: boolean
  lifetime: Lifetime
}

interface Disposable {
  dispose(): void
}

function isDisposable(value: unknown): value is Disposable {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).dispose === 'function'
  )
}

export interface ContainerOptions {
  scope: string
  parent?: Container
  /** Whether this container's services are visible to child containers by default (the kernel root container usually sets true). */
  shareable?: boolean
  /** Whether to run in "plugin scope" (plugin containers do not auto-export to the parent; parent services require explicit export to be visible). */
  pluginScope?: boolean
}

/**
 * Parent container reference table (module-private).
 *
 * Why a module-private WeakMap instead of a `private parentContainer` field:
 * TypeScript's `private` is only a compile-time constraint; at runtime the field is still an enumerable, writable plain property,
 * so a plugin could do `(ctx.container as any).parentContainer` to grab the root container and then resolve any kernel service
 * or service exported by another plugin, completely bypassing CapabilityGuard.
 * With the parent reference in a module-private WeakMap, the container instance carries no property or method pointing to the parent,
 * so plugins cannot obtain it at runtime, while `resolve()` can still delegate upward internally.
 */
const PARENTS = new WeakMap<Container, Container>()

function parentOf(container: Container): Container | undefined {
  return PARENTS.get(container)
}

export class Container implements ContainerContract, ServiceRegistry {
  readonly scope: string
  private readonly shareable: boolean
  private readonly pluginScope: boolean
  private readonly registrations = new Map<string, Registration>()
  private readonly exported = new Set<string>()
  /** Mounted child containers: their exports are consulted on a resolution miss (sibling-plugin consumption). */
  private readonly mountedChildren = new Map<string, Container>()
  private readonly resolving: string[] = []
  private disposed = false

  constructor(opts: ContainerOptions) {
    this.scope = opts.scope
    if (opts.parent) PARENTS.set(this, opts.parent)
    this.shareable = opts.shareable ?? false
    this.pluginScope = opts.pluginScope ?? false
  }

  /** Whether a parent exists: exposes only the boolean, never the parent reference itself. */
  get hasParent(): boolean {
    return PARENTS.has(this)
  }

  register<T>(
    token: ServiceToken<T>,
    factory: ServiceFactory<T>,
    lifetime: Lifetime | string = Lifetime.Singleton,
  ): this {
    this.assertNotDisposed()
    this.registrations.set(token.id, {
      token,
      factory,
      instance: undefined,
      hasInstance: false,
      lifetime: normalizeLifetime(lifetime),
    })
    return this
  }

  registerInstance<T>(token: ServiceToken<T>, instance: T): this {
    this.assertNotDisposed()
    this.registrations.set(token.id, {
      token,
      factory: null,
      instance,
      hasInstance: true,
      lifetime: Lifetime.Singleton,
    })
    return this
  }

  resolve<T>(token: ServiceToken<T>): T {
    this.assertNotDisposed()
    const reg = this.registrations.get(token.id) as Registration<T> | undefined
    if (reg) {
      return this.instantiate<T>(reg)
    }

    // Sibling plugins: fall through to the exports of mounted child containers.
    for (const child of this.mountedChildren.values()) {
      if (child.isExported(token.id)) {
        const found = child.tryResolve<T>(token)
        if (found !== undefined) return found
      }
    }

    const parent = parentOf(this)
    if (parent && parent.canBeResolvedByChild(token.id, this.pluginScope)) {
      return parent.resolve<T>(token)
    }

    throw new NoProviderError(token.id)
  }

  tryResolve<T>(token: ServiceToken<T>): T | undefined {
    try {
      return this.resolve(token)
    } catch {
      return undefined
    }
  }

  has(token: ServiceToken<unknown>): boolean {
    if (this.registrations.has(token.id)) return true
    const parent = parentOf(this)
    if (parent && parent.canBeResolvedByChild(token.id, this.pluginScope)) {
      return parent.has(token)
    }
    return false
  }

  list(): string[] {
    const own = Array.from(this.registrations.keys())
    const inherited: string[] = []
    const parent = parentOf(this)
    if (parent) {
      for (const id of parent.visibleIds()) {
        if (parent.canBeResolvedByChild(id, this.pluginScope)) {
          inherited.push(id)
        }
      }
    }
    return Array.from(new Set([...own, ...inherited])).sort()
  }

  createChild(scope: string): Container {
    this.assertNotDisposed()
    return new Container({ scope, parent: this, pluginScope: true })
  }

  markExported<T>(token: ServiceToken<T>): void {
    this.exported.add(token.id)
  }

  markUnexported<T>(token: ServiceToken<T>): void {
    this.exported.delete(token.id)
  }

  isExported(id: string): boolean {
    return this.exported.has(id)
  }

  /** Whether this container still has any exported services (the kernel uses this to decide whether to unmount). */
  hasExports(): boolean {
    return this.exported.size > 0
  }

  exportService<T>(token: ServiceToken<T>): void {
    this.markExported(token)
  }

  unexportService<T>(token: ServiceToken<T>): void {
    this.markUnexported(token)
  }

  /**
   * Mount a child container: its exports are consulted on a resolution miss.
   * Called by the plugin `api.export()`, letting the parent resolve
   * child-exported services on demand.
   */
  mountChildContainer(child: Container): void {
    this.mountedChildren.set(child.scope, child)
  }

  unmountChildContainer(child: Container): void {
    this.mountedChildren.delete(child.scope)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const reg of this.registrations.values()) {
      if (reg.hasInstance && isDisposable(reg.instance)) {
        try {
          reg.instance.dispose()
        } catch {
          // Ignore per-service dispose failures so remaining services are still released.
        }
      }
    }
    this.registrations.clear()
    this.exported.clear()
    for (const child of this.mountedChildren.values()) child.dispose()
    this.mountedChildren.clear()
  }

  /**
   * Whether this container can resolve a given id on behalf of a child.
   *
   * Must stay consistent with the lookup order in `resolve()`; three paths:
   * 1. Own registrations (requires shareable or an explicit markExported).
   * 2. Services exported by mounted child containers (sibling-plugin
   *    consumption). Omitting this path would let resolve() hit a service
   *    while the visibility check denies it first, causing an "exported
   *    yet NoProviderError" inconsistency.
   * 3. Delegation upward to the parent.
   */
  private canBeResolvedByChild(id: string, childPluginScope: boolean): boolean {
    if (this.registrations.has(id)) {
      if (this.shareable) return true
      if (this.exported.has(id)) return true
      void childPluginScope
      return false
    }

    for (const child of this.mountedChildren.values()) {
      if (child.isExported(id)) return true
    }

    const parent = parentOf(this)
    if (parent) {
      return parent.canBeResolvedByChild(id, childPluginScope)
    }
    return false
  }

  private visibleIds(): string[] {
    const own = Array.from(this.registrations.keys())
    const parent = parentOf(this)
    const up = parent ? parent.visibleIds() : []
    const mounted: string[] = []
    for (const child of this.mountedChildren.values()) {
      mounted.push(...child.exportedIds())
    }
    return Array.from(new Set([...own, ...up, ...mounted]))
  }

  /** Service ids explicitly exported by this container (aggregated by the parent for visibility). */
  private exportedIds(): string[] {
    return Array.from(this.exported)
  }

  private instantiate<T>(reg: Registration<T>): T {
    if (reg.hasInstance) {
      return reg.instance as T
    }

    const tokenId = reg.token.id
    if (this.resolving.includes(tokenId)) {
      throw new CircularDependencyError('service', [...this.resolving, tokenId])
    }

    let value: T
    if (reg.factory === null) {
      value = reg.instance as T
    } else {
      this.resolving.push(tokenId)
      try {
        value = reg.factory(this)
      } finally {
        this.resolving.pop()
      }
    }

    if (
      reg.lifetime === Lifetime.Singleton ||
      reg.lifetime === Lifetime.Scoped
    ) {
      reg.instance = value
      reg.hasInstance = true
    }
    return value
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error(`container disposed: ${this.scope}`)
    }
  }
}

export { Container as DiContainer }
