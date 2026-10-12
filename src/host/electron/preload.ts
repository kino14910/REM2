/**
 * Electron preload 脚本 —— **唯一的契约边界**（docs/12 B2）。
 *
 * 暴露 `window.rem2 = { invoke, onEvent }`（2 个方法，替代旧的
 * `execute` + `onBroadcast`），方法名与事件名由 `host/ipc/channels.ts` 的白名单约束。
 *
 * preload 里**不做**任何白名单判定：判定必须在主进程侧（renderer 不可信）。
 */

import { contextBridge, ipcRenderer } from 'electron';
import { Ipc, type IpcEventPayload, type IpcResponse } from '../ipc/channels.js';

/** 暴露给渲染进程的 API 形状（前端 `lib/ipc-client.ts` 与之对齐）。 */
export interface Rem2Bridge {
  /** 调用一个白名单方法。 */
  invoke(method: string, args?: unknown): Promise<unknown>;
  /** 订阅一个白名单事件，返回退订函数。 */
  onEvent(event: string, handler: (payload: unknown) => void): () => void;
}

const rem2Api: Rem2Bridge = {
  invoke(method: string, args?: unknown): Promise<unknown> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const handler = (_event: unknown, payload: IpcResponse): void => {
        if (!payload || payload.id !== id) return;
        ipcRenderer.removeListener(Ipc.Invoke, handler);
        if (payload.ok) resolve(payload.result);
        else reject(new Error(payload.error ?? '未知错误'));
      };
      ipcRenderer.on(Ipc.Invoke, handler);
      ipcRenderer.send(Ipc.Invoke, { id, method, args });
    });
  },

  onEvent(event: string, handler: (payload: unknown) => void): () => void {
    const listener = (_e: unknown, dto: IpcEventPayload): void => {
      if (!dto || dto.event !== event) return;
      handler(dto.payload);
    };
    ipcRenderer.on(Ipc.Event, listener);
    return () => ipcRenderer.removeListener(Ipc.Event, listener);
  },
};

contextBridge.exposeInMainWorld('rem2', rem2Api);
