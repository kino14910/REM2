/**
 * 事件总线契约（纯类型）。见 docs/01
 */

/** 退订函数。 */
export type Unsubscribe = () => void;

/** 订阅选项。 */
export interface OnOptions {
  /** 越大越先执行，默认 0。 */
  priority?: number;
  /** 订阅来源插件 id（内核自动注入，用于错误归因）。 */
  pluginId?: string;
}

/** RPC 选项。 */
export interface RequestOptions {
  timeoutMs?: number;
}

/** 事件处理函数。 */
export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

/**
 * 事件总线契约。
 *
 * 语义（见 docs/01）：异步顺序派发；优先级降序、同级按订阅时间升序；
 * 订阅者抛错被隔离，不影响其他订阅者与发布者（动机 #6）。
 */
export interface EventBus {
  /** 广播：异步顺序派发。 */
  emit<T = unknown>(event: string, payload?: T): Promise<void>;

  /** 订阅：支持通配符模式。 */
  on<T = unknown>(
    pattern: string,
    handler: EventHandler<T>,
    opts?: OnOptions,
  ): Unsubscribe;

  /** 单次订阅。 */
  once<T = unknown>(pattern: string, handler: EventHandler<T>): Unsubscribe;

  /** 取消订阅。 */
  off(pattern: string, handler: (...args: never[]) => unknown): void;

  /** 请求-响应（RPC）：找第一个匹配的 responder，超时抛 TimeoutError。 */
  request<TReq = unknown, TRes = unknown>(
    topic: string,
    payload?: TReq,
    opts?: RequestOptions,
  ): Promise<TRes>;

  /** 注册 RPC 响应者。 */
  respond<TReq = unknown, TRes = unknown>(
    topic: string,
    handler: (payload: TReq) => TRes | Promise<TRes>,
  ): Unsubscribe;

  /** 通配符匹配（供测试/调试）。 */
  matching(pattern: string, event: string): boolean;

  /** 清空所有订阅（内核 shutdown 使用）。 */
  clear(): void;
}
