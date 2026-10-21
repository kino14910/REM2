/**
 * ServiceRegistry is a narrow interface view over Container.
 * Plugins receive a trimmed registry whose `resolve` goes through the
 * capability proxy (wrapped by CapabilityGuard).
 */

import type {
  ServiceToken,
  ServiceFactory,
  Lifetime,
} from '../contracts/service-token.js'
import type { Container } from '../contracts/container.js'
import type { ServiceRegistry } from '../contracts/service.js'

export class ServiceRegistryFacade implements ServiceRegistry {
  constructor(private readonly container: Container) {}

  register<T>(
    token: ServiceToken<T>,
    factory: ServiceFactory<T>,
    lifetime?: Lifetime,
  ): this {
    this.container.register(token, factory, lifetime)
    return this
  }

  registerInstance<T>(token: ServiceToken<T>, instance: T): this {
    this.container.registerInstance(token, instance)
    return this
  }

  resolve<T>(token: ServiceToken<T>): T {
    return this.container.resolve(token)
  }

  tryResolve<T>(token: ServiceToken<T>): T | undefined {
    return this.container.tryResolve(token)
  }

  has(token: ServiceToken<unknown>): boolean {
    return this.container.has(token)
  }

  list(): string[] {
    return this.container.list()
  }
}
