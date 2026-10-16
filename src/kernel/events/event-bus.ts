/**
 * 事件总线（见 docs/01）。
 *
 * 语义：
 * - `emit`：异步顺序派发；订阅者异常被隔离（catch + 记录 + 可选回调），不影响发布者与其他订阅者（动机 #6）。
 * - `request/respond`：RPC，超时抛 TimeoutError。
 * - 派发顺序：priority 降序 → 订阅 seq 升序（完全确定）。
 * - 派发使用快照，订阅/退订期间修改不影响正在进行的一次派发。
 *
 * 桶索引（docs/09 O16）：订阅按「模式首段」分桶，桶内**在订阅期**就定好序
 * （`insertOrdered`），emit 时只需顺序遍历两个桶（精确桶 + 通配桶），
 * 不再对全表 filter + sort。派发顺序语义与旧实现逐条等价。
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
import {
  matches,
  bucketKeyOf,
  bucketKeyOfEvent,
  WILDCARD_BUCKET,
} from './pattern.js';
import { compareHandlers, insertOrdered, normalizePriority } from './priority.js';

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
  /**
   * 桶索引：bucketKey → 已按 (priority 降序, seq 升序) 排好的订阅数组。
   * 桶内**只增不改序**，因此 emit 无需排序。
   */
  private readonly buckets = new Map<string, Subscription[]>();
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
    let n = 0;
    for (const arr of this.buckets.values()) n += arr.length;
    return n;
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
          this.removeSubscription(sub);
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
    this.insert(sub);
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
    this.insert(sub);
    return () => this.removeSubscription(sub);
  }

  off(pattern: string, handler: (...args: never[]) => unknown): void {
    const bucket = this.buckets.get(bucketKeyOf(pattern));
    if (!bucket) return;
    const keep = bucket.filter(
      (s) => !(s.pattern === pattern && s.handler === handler),
    );
    if (keep.length === 0) this.buckets.delete(bucketKeyOf(pattern));
    else this.buckets.set(bucketKeyOf(pattern), keep);
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
    this.buckets.clear();
    this.responders = [];
    this.seqCounter = 0;
  }

  // ────────────────── 内部 ──────────────────

  /** 订阅入桶：按首段分桶，桶内二分插入保持 (priority 降序, seq 升序)。 */
  private insert(sub: Subscription): void {
    const key = bucketKeyOf(sub.pattern);
    const bucket = this.buckets.get(key) ?? [];
    insertOrdered(bucket, sub);
    this.buckets.set(key, bucket);
  }

  /**
   * 取某事件的候选订阅快照。
   *
   * 只需要看两个桶：事件首段对应的精确桶 + 通配桶（`*` / `**` 模式）。
   * 仍需 `matches` 复核 —— 桶只是**必要条件**的快速过滤，
   * 例如 `a:*` 与 `a:b` 同在 `a` 桶但后者不该匹配前者的事件。
   */
  private collect(event: string): Subscription[] {
    const out: Subscription[] = [];
    const exact = this.buckets.get(bucketKeyOfEvent(event));
    if (exact) {
      for (const s of exact) {
        if (!s.removed && matches(s.pattern, event)) out.push(s);
      }
    }
    const wildcard = this.buckets.get(WILDCARD_BUCKET);
    if (wildcard) {
      for (const s of wildcard) {
        if (!s.removed && matches(s.pattern, event)) out.push(s);
      }
    }
    // 两个桶各自有序，合并后需按同一比较器归并。
    out.sort(compareHandlers as (a: Subscription, b: Subscription) => number);
    return out;
  }

  private pickResponder(topic: string): Responder | undefined {
    const candidates = this.responders
      .filter((r) => !r.removed && r.topic === topic)
      .sort((a, b) => a.seq - b.seq);
    return candidates[0];
  }

  private removeSubscription(sub: Subscription): void {
    if (sub.removed) return;
    sub.removed = true;
    const key = bucketKeyOf(sub.pattern);
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    const idx = bucket.indexOf(sub);
    if (idx >= 0) bucket.splice(idx, 1);
    if (bucket.length === 0) this.buckets.delete(key);
  }
}

/** 兼容别名（类图使用 EventBus 名称）。 */
export { EventBusImpl as KernelEventBus };
