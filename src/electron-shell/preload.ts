/**
 * Electron preload 脚本（可选外壳）。
 *
 * 通过 contextBridge 暴露一个最小的 `window.rem2` API，转发命令到主进程内核。
 * 该文件在 Electron 渲染进程中运行，**不参与内核逻辑**。
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IpcTopics } from '../runtime/ipc/ipc-topics.js';

/** 暴露给渲染进程的 API。 */
const rem2Api = {
  /** 执行一条命令（转发到内核命令总线）。 */
  execute(method: string, args?: unknown): Promise<unknown> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const handler = (
        _event: unknown,
        payload: { id: string; ok: boolean; result?: unknown; error?: string },
      ): void => {
        if (payload.id !== id) return;
        ipcRenderer.removeListener(IpcTopics.Response, handler);
        if (payload.ok) resolve(payload.result);
        else reject(new Error(payload.error ?? '未知错误'));
      };
      ipcRenderer.on(IpcTopics.Response, handler);
      ipcRenderer.send(IpcTopics.Request, { id, method, args });
    });
  },

  /** 订阅内核广播。 */
  onBroadcast(handler: (payload: unknown) => void): () => void {
    const listener = (_event: unknown, payload: unknown): void =>
      handler(payload);
    ipcRenderer.on(IpcTopics.Broadcast, listener);
    return () => ipcRenderer.removeListener(IpcTopics.Broadcast, listener);
  },
};

contextBridge.exposeInMainWorld('rem2', rem2Api);
