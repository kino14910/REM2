/**
 * 事件总线（docs/02 §G.1 / §G.3）。
 *
 * 语义：
 * - `emit`：异步顺序派发；订阅者异常被隔离（catch + 记录 + 可选回调），不影响发布者与其他订阅者（动机 #6）。
 * - `request/respond`：RPC，超时抛 TimeoutError。
 * - 派发顺序：priority 降序 → 订阅 seq 升序（完全确定）。
 * - 派发使用快照，订阅/退订期间修改不影响正在进行的一次派发。
 */

import type {
  EventBus,
  EventHandler,
  OnOptions,
  RequestOptions,
  Unsubscribe,
} from '../contracts/event-bus.js';
import { NoResponderError } from '../errors.js';
import { withTimeout } from '../util/timeout.js';
import { matches } from './pattern.js';
import { compareHandlers, normalizePriority } from './priority.js';

interface Subscription {
  pattern: string;
  handler: (...args: never[]) => unknown;
  priority: number;
  once: boolean;
  seq: number;
  pluginId?: string;
  removed: boolean;
}

interface Responder {
  topic: string;
  handler: (payload: never) => unknown;
  seq: number;
  removed: boolean;
}

/** 订阅者错误回调。 */
export type HandlerErrorCallback = (
  event: string,
  error: unknown,
  pluginId?: string,
) => void;

/** 事件总线构造选项。 */
export interface EventBusOptions {
  /** 订阅者错误回调。 */
  onHandlerError?: HandlerErrorCallback;
}

/**
 * 事件总线实现。
 */
export class EventBusImpl implements EventBus {
  private subscriptions: Subscription[] = [];
  private responders: Responder[] = [];
  private seqCounter = 0;
  private readonly onHandlerError: HandlerErrorCallback | null;
  /** 累计的订阅者错误（供指标/测试断言）。 */
  private readonly errors: Array<{
    event: string;
    error: unknown;
    pluginId?: string;
  }> = [];

  constructor(opts: EventBusOptions = {}) {
    this.onHandlerError = opts.onHandlerError ?? null;
  }

  /** 读取累计错误（测试/健康检查）。 */
  getErrors(): ReadonlyArray<{
    event: string;
    error: unknown;
    pluginId?: string;
  }> {
    return this.errors;
  }

  /** 当前订阅数量（测试用）。 */
  size(): number {
    return this.subscriptions.length;
  }

  async emit<T = unknown>(event: string, payload?: T): Promise<void> {
    const snapshot = this.collect(event);

    for (const sub of snapshot) {
      if (sub.removed) continue;
      try {
        await sub.handler(payload as never);
      } catch (error) {
        this.errors.push({
          event,
          error,
          ...(sub.pluginId ? { pluginId: sub.pluginId } : {}),
        });
        this.onHandlerError?.(event, error, sub.pluginId);
      } finally {
        if (sub.once) {
          sub.removed = true;
          this.subscriptions = this.subscriptions.filter((s) => s !== sub);
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
    };
    this.subscriptions.push(sub);
    return () => this.removeSubscription(sub);
  }

  once<T = unknown>(pattern: string, handler: EventHandler<T>): Unsubscribe {
    const sub: Subscription = {
      pattern,
      handler: handler as (...args: never[]) => unknown,
      priority: 0,
      once: true,
      seq: this.seqCounter++,
      removed: false,
    };
    this.subscriptions.push(sub);
    return () => this.removeSubscription(sub);
  }

  off(pattern: string, handler: (...args: never[]) => unknown): void {
    this.subscriptions = this.subscriptions.filter(
      (s) => !(s.pattern === pattern && s.handler === handler),
    );
  }

  async request<TReq = unknown, TRes = unknown>(
    topic: string,
    payload?: TReq,
    opts?: RequestOptions,
  ): Promise<TRes> {
    const responder = this.pickResponder(topic);
    if (!responder) {
      throw new NoResponderError(topic);
    }
    const timeoutMs = opts?.timeoutMs ?? 5000;
    if (timeoutMs <= 0) {
      return (await responder.handler(payload as never)) as TRes;
    }
    return await withTimeout(
      Promise.resolve(responder.handler(payload as never)) as Promise<TRes>,
      timeoutMs,
      topic,
    );
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
    };
    this.responders.push(r);
    return () => {
      r.removed = true;
      this.responders = this.responders.filter((x) => x !== r);
    };
  }

  matching(pattern: string, event: string): boolean {
    return matches(pattern, event);
  }

  clear(): void {
    this.subscriptions = [];
    this.responders = [];
    this.seqCounter = 0;
  }

  // ────────────────── 内部 ──────────────────

  private collect(event: string): Subscription[] {
    return this.subscriptions
      .filter((s) => !s.removed && matches(s.pattern, event))
      .sort(compareHandlers as (a: Subscription, b: Subscription) => number);
  }

  private pickResponder(topic: string): Responder | undefined {
    const candidates = this.responders
      .filter((r) => !r.removed && r.topic === topic)
      .sort((a, b) => a.seq - b.seq);
    return candidates[0];
  }

  private removeSubscription(sub: Subscription): void {
    sub.removed = true;
    this.subscriptions = this.subscriptions.filter((s) => s !== sub);
  }
}

/** 兼容别名（类图使用 EventBus 名称）。 */
export { EventBusImpl as KernelEventBus };
