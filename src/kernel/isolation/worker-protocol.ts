/**
 * Worker 消息协议的**单一来源**（docs/06 §1.2 新增文件）。
 *
 * 之前协议常量内联在 `worker-host.ts`（判别式 `msg.t`）与 `worker-bootstrap.ts`
 * （Worker 内的 `switch (msg.t)`）两处，两份字符串靠人工保持同步。
 * 现在消息类型集中在此，`worker-bootstrap.ts` 以字符串常量数组注入引导源码。
 */

/** 内核 → Worker 的消息类型。 */
export const HOST_TO_WORKER = {
  /** 初始化：传入 entry 说明符、manifest、rootDir、配置与权限快照。 */
  Init: 'init',
  /** 生命周期钩子 RPC。 */
  Call: 'call',
  /** 事件派发。 */
  Event: 'event',
  /** 配置快照推送。 */
  Config: 'config',
  /** 上下文调用回包。 */
  CtxResult: 'ctx-result',
} as const;

/** Worker → 内核的消息类型。 */
export const WORKER_TO_HOST = {
  /** 初始化完成。 */
  Ready: 'ready',
  /** 初始化失败。 */
  InitError: 'init-error',
  /** 钩子执行结果。 */
  Result: 'result',
  /** 上下文调用请求。 */
  Ctx: 'ctx',
  /** 事件订阅。 */
  Subscribe: 'subscribe',
  /** 事件退订。 */
  Unsub: 'unsub',
} as const;

export type HostToWorkerType = (typeof HOST_TO_WORKER)[keyof typeof HOST_TO_WORKER];
export type WorkerToHostType = (typeof WORKER_TO_HOST)[keyof typeof WORKER_TO_HOST];

/** 初始化消息。 */
export interface InitMessage {
  t: typeof HOST_TO_WORKER.Init;
  entrySpecifier: string;
  manifest: { id: string; name: string; version: string };
  rootDir: string;
  configSnapshot: Record<string, unknown>;
  /** 真实权限快照（C8：旧实现硬编码空集）。 */
  permissions: { granted: string[]; denied: string[] };
}

/** 钩子调用消息。 */
export interface CallMessage {
  t: typeof HOST_TO_WORKER.Call;
  id: number;
  hook: string;
  args: unknown[];
}

/** 上下文调用请求。 */
export interface CtxCallMessage {
  t: typeof WORKER_TO_HOST.Ctx;
  id: number;
  path: string[];
  args: unknown[];
}

/** Worker 侧允许贡献的扩展点（值必须可结构化克隆，docs/03 §6.2）。 */
export const WORKER_ALLOWED_EXTENSION_POINTS = [
  'log.sink',
  'metrics.sink',
  'trace.exporter',
] as const;
