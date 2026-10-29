/**
 * Electron preload script — the single contract boundary.
 *
 * Exposes `window.rem2 = { invoke, onEvent }` (two methods, replacing the old
 * `execute` + `onBroadcast`). Method and event names are constrained by the
 * whitelist in `shared/ipc-contract.ts`.
 *
 * No whitelist checks happen here: enforcement belongs on the main-process
 * side (the renderer is untrusted).
 */

import { contextBridge, ipcRenderer } from 'electron'
import {
  Ipc,
  type IpcEventPayload,
  type IpcResponse,
} from '../../shared/ipc-contract.js'

/** Shape of the API exposed to the renderer (mirrored by the frontend `lib/ipc-client.ts`). */
export interface Rem2Bridge {
  /** Invoke a whitelisted method. */
  invoke(method: string, args?: unknown): Promise<unknown>
  /** Subscribe to a whitelisted event; returns an unsubscribe function. */
  onEvent(event: string, handler: (payload: unknown) => void): () => void
}

const rem2Api: Rem2Bridge = {
  invoke(method: string, args?: unknown): Promise<unknown> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve, reject) => {
      const handler = (_event: unknown, payload: IpcResponse): void => {
        if (!payload || payload.id !== id) return
        ipcRenderer.removeListener(Ipc.Invoke, handler)
        if (payload.ok) resolve(payload.result)
        else {
          const error = new Error(payload.error ?? 'Unknown error') as Error & {
            code?: string
          }
          if (payload.errorCode) error.code = payload.errorCode
          reject(error)
        }
      }
      ipcRenderer.on(Ipc.Invoke, handler)
      ipcRenderer.send(Ipc.Invoke, { id, method, args })
    })
  },

  onEvent(event: string, handler: (payload: unknown) => void): () => void {
    const listener = (_e: unknown, dto: IpcEventPayload): void => {
      if (!dto || dto.event !== event) return
      handler(dto.payload)
    }
    ipcRenderer.on(Ipc.Event, listener)
    return () => ipcRenderer.removeListener(Ipc.Event, listener)
  },
}

contextBridge.exposeInMainWorld('rem2', rem2Api)
