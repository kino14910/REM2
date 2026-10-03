/**
 * IPC 主题常量（docs/02 §M.3：Electron 外壳通过 IpcBridge 适配，内核不认识 IPC）。
 */

/** IPC 主题。 */
export const IpcTopics = {
  /** 渲染进程 → 主进程：请求执行命令。 */
  Request: 'ipc:request',
  /** 主进程 → 渲染进程：命令结果。 */
  Response: 'ipc:response',
  /** 主进程 → 渲染进程：广播事件。 */
  Broadcast: 'ipc:broadcast',
} as const;

export type IpcTopic = (typeof IpcTopics)[keyof typeof IpcTopics];
