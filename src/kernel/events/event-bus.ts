/**
 * Event bus semantics:
 * - `emit`: asynchronous in-order dispatch; subscriber errors are isolated
 *   (caught, recorded, optional callback) and never affect the publisher or
 *   other subscribers.
 * - `request`/`respond`: RPC; timeouts throw TimeoutError.
 * - Dispatch order: priority descending, then subscription seq ascending
 *   (fully deterministic).
 * - Dispatch uses a snapshot: subscribe/unsubscribe during a dispatch does
 *   not affect that dispatch.
 *
 * Bucket index: subscriptions are bucketed by the first segment of their
 * pattern and ordered within the bucket at subscription time
 * (`insertOrdered`), so emit only walks two buckets (exact + wildcard)
 * instead of filtering and sorting the whole table.
 */

import type {
  EventBus,
  EventHandler,
  OnOptions,
  RequestOptions,
  Unsubscribe,
} from '../contracts/event-bus.js'
import { NoResponderError } from '../errors.js'
import { withTimeout } from '../util/timeout.js'
import {
  matches,
  bucketKeyOf,
  bucketKeyOfEvent,
  WILDCARD_BUCKET,
} from './pattern.js'
import {
  compareHandlers,
  insertOrdered,
  normalizePriority,
} from './priority.js'

interface Subscription {
  pattern: string
  handler: (...args: never[]) => unknown
  priority: number
  once: boolean
  seq: number
  pluginId?: string
  removed: boolean
}

interface Responder {
  topic: string
  handler: (payload: never) => unknown
  seq: number
  removed: boolean
}

export type HandlerErrorCallback = (
  event: string,
  error: unknown,
  pluginId?: string,
) => void

export interface EventBusOptions {
  onHandlerError?: HandlerErrorCallback
}

export class EventBusImpl implements EventBus {
  /**
   * Bucket index: bucketKey -> subscriptions pre-ordered by
   * (priority descending, seq ascending).
   * Buckets only grow in order, so emit never needs to sort within a bucket.
   */
  private readonly buckets = new Map<string, Subscription[]>()
  private responders: Responder[] = []
  private seqCounter = 0
  private readonly onHandlerError: HandlerErrorCallback | null
  /** Accumulated subscriber errors (for metrics and test assertions). */
  private readonly errors: Array<{
    event: string
    error: unknown
    pluginId?: string
  }> = []

  constructor(opts: EventBusOptions = {}) {
    this.onHandlerError = opts.onHandlerError ?? null
  }

  /** Read accumulated errors (for tests and health checks). */
  getErrors(): ReadonlyArray<{
    event: string
    error: unknown
    pluginId?: string
  }> {
    return this.errors
  }

  /** Current subscription count (for tests). */
  size(): number {
    let n = 0
    for (const arr of this.buckets.values()) n += arr.length
    return n
  }

  async emit<T = unknown>(event: string, payload?: T): Promise<void> {
    const snapshot = this.collect(event)

    for (const sub of snapshot) {
      if (sub.removed) continue
      try {
        await sub.handler(payload as never)
      } catch (error) {
        this.errors.push({
          event,
          error,
          ...(sub.pluginId ? { pluginId: sub.pluginId } : {}),
        })
        this.onHandlerError?.(event, error, sub.pluginId)
      } finally {
        if (sub.once) {
          this.removeSubscription(sub)
        }
      }
    }
  }

  on<T = unknown>(
    pattern: string,
    handler: EventHandler<T>,
    opts?: OnOptions,
  ): Unsubscribe {
    const sub: Subscription = {
      pattern,
      handler: handler as (...args: never[]) => unknown,
      priority: normalizePriority(opts?.priority),
      once: false,
      seq: this.seqCounter++,
      ...(opts?.pluginId ? { pluginId: opts.pluginId } : {}),
      removed: false,
    }
    this.insert(sub)
    return () => this.removeSubscription(sub)
  }

  once<T = unknown>(pattern: string, handler: EventHandler<T>): Unsubscribe {
    const sub: Subscription = {
      pattern,
      handler: handler as (...args: never[]) => unknown,
      priority: 0,
      once: true,
      seq: this.seqCounter++,
      removed: false,
    }
    this.insert(sub)
    return () => this.removeSubscription(sub)
  }

  off(pattern: string, handler: (...args: never[]) => unknown): void {
    const bucket = this.buckets.get(bucketKeyOf(pattern))
    if (!bucket) return
    const keep = bucket.filter(
      s => !(s.pattern === pattern && s.handler === handler),
    )
    if (keep.length === 0) this.buckets.delete(bucketKeyOf(pattern))
    else this.buckets.set(bucketKeyOf(pattern), keep)
  }

  async request<TReq = unknown, TRes = unknown>(
    topic: string,
    payload?: TReq,
    opts?: RequestOptions,
  ): Promise<TRes> {
    const responder = this.pickResponder(topic)
    if (!responder) {
      throw new NoResponderError(topic)
    }
    const timeoutMs = opts?.timeoutMs ?? 5000
    if (timeoutMs <= 0) {
      return (await responder.handler(payload as never)) as TRes
    }
    return await withTimeout(
      Promise.resolve(responder.handler(payload as never)) as Promise<TRes>,
      timeoutMs,
      topic,
    )
  }

  respond<TReq = unknown, TRes = unknown>(
    topic: string,
    handler: (payload: TReq) => TRes | Promise<TRes>,
  ): Unsubscribe {
    const r: Responder = {
      topic,
      handler: handler as (payload: never) => unknown,
      seq: this.seqCounter++,
      removed: false,
    }
    this.responders.push(r)
    return () => {
      r.removed = true
      this.responders = this.responders.filter(x => x !== r)
    }
  }

  matching(pattern: string, event: string): boolean {
    return matches(pattern, event)
  }

  clear(): void {
    this.buckets.clear()
    this.responders = []
    this.seqCounter = 0
  }

  private insert(sub: Subscription): void {
    const key = bucketKeyOf(sub.pattern)
    const bucket = this.buckets.get(key) ?? []
    insertOrdered(bucket, sub)
    this.buckets.set(key, bucket)
  }

  /**
   * Collect the candidate subscription snapshot for an event.
   *
   * Only two buckets are scanned: the exact bucket for the event's first
   * segment plus the wildcard bucket (`*` / `**` patterns). A `matches`
   * re-check is still required: the bucket is only a fast necessary-
   * condition filter, e.g. `a:*` and `a:b` share the `a` bucket but the
   * latter must not match the former's event.
   */
  private collect(event: string): Subscription[] {
    const out: Subscription[] = []
    const exact = this.buckets.get(bucketKeyOfEvent(event))
    if (exact) {
      for (const s of exact) {
        if (!s.removed && matches(s.pattern, event)) out.push(s)
      }
    }
    const wildcard = this.buckets.get(WILDCARD_BUCKET)
    if (wildcard) {
      for (const s of wildcard) {
        if (!s.removed && matches(s.pattern, event)) out.push(s)
      }
    }
    // Each bucket is already ordered; merging requires re-sorting with the same comparator.
    out.sort(compareHandlers as (a: Subscription, b: Subscription) => number)
    return out
  }

  private pickResponder(topic: string): Responder | undefined {
    const candidates = this.responders
      .filter(r => !r.removed && r.topic === topic)
      .sort((a, b) => a.seq - b.seq)
    return candidates[0]
  }

  private removeSubscription(sub: Subscription): void {
    if (sub.removed) return
    sub.removed = true
    const key = bucketKeyOf(sub.pattern)
    const bucket = this.buckets.get(key)
    if (!bucket) return
    const idx = bucket.indexOf(sub)
    if (idx >= 0) bucket.splice(idx, 1)
    if (bucket.length === 0) this.buckets.delete(key)
  }
}

export { EventBusImpl as KernelEventBus }
