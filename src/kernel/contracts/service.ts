/**
 * Service registry / DI contracts.
 *
 * Token types are defined once in `service-token.ts` and re-exported here.
 */

import type { ServiceToken, ServiceFactory, Lifetime } from './service-token.js'

export type {
  ServiceToken,
  ServiceFactory,
  Lifetime,
  ServiceDescriptor,
} from './service-token.js'

/** Service registry facade; implemented by Container. */
export interface ServiceRegistry {
  register<T>(
    token: ServiceToken<T>,
    factory: ServiceFactory<T>,
    lifetime?: Lifetime,
  ): this
  registerInstance<T>(token: ServiceToken<T>, instance: T): this
  resolve<T>(token: ServiceToken<T>): T
  tryResolve<T>(token: ServiceToken<T>): T | undefined
  has(token: ServiceToken<unknown>): boolean
  list(): string[]
}

/** Plugin-visible services view: same shape as ServiceRegistry; named separately so it does not imply that plugins can reach the kernel registry. */
export type ServicesView = ServiceRegistry
