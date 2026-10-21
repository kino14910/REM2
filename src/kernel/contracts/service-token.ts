/**
 * Service token and DI descriptor contracts (branded interface plus a
 * pure function factory).
 *
 * `ServiceToken` is a branded interface rather than a class: a class would
 * pull prototype chains and constructors into the bundle, and a `static
 * create` would depend on module-level state. The branded interface plus
 * the pure `defineToken` function makes every copy of a token behave
 * identically.
 */

declare const TOKEN_BRAND: unique symbol

export type Lifetime = 'singleton' | 'transient' | 'scoped'

/** Enum-style type alias equivalent to Lifetime. */
export type LifetimeValue = Lifetime

export interface ServiceDescriptor<T> {
  /** Unique id, e.g. 'kernel.event-bus' / 'plugin.hello.greeter'. */
  id: string
  /** Human-readable description. */
  describe: string
  /** Capability this service requires (used for permission checks); absence means a public capability. */
  capability?: string
  /** Type inference only; does not exist at runtime. */
  __type?: T
}

/** Strongly typed service token: a branded interface that literals cannot forge at compile time. */
export interface ServiceToken<T> extends ServiceDescriptor<T> {
  readonly [TOKEN_BRAND]: true
}

export type ServiceFactory<T> = (c: unknown) => T

/** Creates a service token (the only construction entry point; a pure function with no module-level state). */
export function defineToken<T>(
  descriptor: ServiceDescriptor<T>,
): ServiceToken<T> {
  if (!descriptor.id || typeof descriptor.id !== 'string') {
    throw new TypeError('defineToken requires a non-empty id')
  }
  return {
    id: descriptor.id,
    describe: descriptor.describe,
    ...(descriptor.capability !== undefined
      ? { capability: descriptor.capability }
      : {}),
  } as ServiceToken<T>
}
