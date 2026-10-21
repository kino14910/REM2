export type Unsubscribe = () => void

export interface OnOptions {
  /** Higher values run first; defaults to 0. */
  priority?: number
  /** Plugin id of the subscriber (injected by the kernel for error attribution). */
  pluginId?: string
}

export interface RequestOptions {
  timeoutMs?: number
}

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>

/**
 * Event bus contract.
 *
 * Semantics: asynchronous in-order dispatch; higher priority first, ties
 * broken by subscription order; subscriber errors are isolated and never
 * affect other subscribers or the publisher.
 */
export interface EventBus {
  /** Broadcast: asynchronous in-order dispatch. */
  emit<T = unknown>(event: string, payload?: T): Promise<void>

  /** Subscribe: supports wildcard patterns. */
  on<T = unknown>(
    pattern: string,
    handler: EventHandler<T>,
    opts?: OnOptions,
  ): Unsubscribe

  once<T = unknown>(pattern: string, handler: EventHandler<T>): Unsubscribe

  off(pattern: string, handler: (...args: never[]) => unknown): void

  /** Request-response (RPC): picks the first matching responder; timeouts throw TimeoutError. */
  request<TReq = unknown, TRes = unknown>(
    topic: string,
    payload?: TReq,
    opts?: RequestOptions,
  ): Promise<TRes>

  respond<TReq = unknown, TRes = unknown>(
    topic: string,
    handler: (payload: TReq) => TRes | Promise<TRes>,
  ): Unsubscribe

  /** Wildcard match (for tests and debugging). */
  matching(pattern: string, event: string): boolean

  /** Clear all subscriptions (used on kernel shutdown). */
  clear(): void
}
