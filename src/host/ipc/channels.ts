/**
 * IPC 通道契约与白名单 —— renderer 能做的事的**唯一上限**（docs/12 §4）。
 *
 * 变更（docs/13 C10 / C11）：
 * - 3 个通道（request / response / broadcast）→ **2 个**（`rem2:invoke` / `rem2:event`）。
 *   响应与事件拆开，前端的 `subscribe` 只需监听一个 channel。
 * - 白名单从前缀匹配（`['command:', 'health:']`）改为 **`Set<string>` 精确匹配**。
 *   前缀匹配等于把整个 `command:` 命名空间交出去。
 *
 * 本文件是 preload 与前端 `lib/channels.ts` 的共同来源；两侧不得各写一份。
 */

/** 通道名。 */
export const Ipc = {
  /** renderer → main：请求（带 id，主进程按 id 回包）。 */
  Invoke: 'rem2:invoke',
  /** main → renderer：事件推送（无 id）。 */
  Event: 'rem2:event',
} as const;

export type IpcChannel = (typeof Ipc)[keyof typeof Ipc];

/** 允许 renderer 调用的方法（8 个，穷举）。 */
export const ALLOWED_METHODS = [
  'ui.panel.list',
  'ui.panel.data',
  'ui.route.list',
  'ui.theme.list',
  'ui.theme.set',
  'ui.event',
  'command.execute',
  'health.report',
] as const;

export type AllowedMethod = (typeof ALLOWED_METHODS)[number];

/** 允许推送到 renderer 的事件（5 个，穷举）。 */
export const ALLOWED_EVENTS = [
  'ui.theme.changed',
  'plugin.state-changed',
  'panel.data-changed',
  'command.result',
  'kernel.ready',
] as const;

export type AllowedEvent = (typeof ALLOWED_EVENTS)[number];

/** 方法白名单集合（`IpcBridge` 的判据）。 */
export const ALLOWED_METHOD_SET: ReadonlySet<string> = new Set(ALLOWED_METHODS);

/** 事件白名单集合。 */
export const ALLOWED_EVENT_SET: ReadonlySet<string> = new Set(ALLOWED_EVENTS);

/** IPC 请求负载。 */
export interface IpcRequest {
  id: string;
  method: string;
  args?: unknown;
}

/** IPC 响应负载。 */
export interface IpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** 事件推送负载。 */
export interface IpcEventPayload {
  event: string;
  payload: unknown;
}
