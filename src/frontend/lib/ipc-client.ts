/**
 * The single typed wrapper around `window.rem2`.
 *
 * All IPC calls must go through here because it:
 * 1. hides channel names and id matching details;
 * 2. gives `window.rem2` a compile-time shape (preload injects it via
 *    contextBridge, so TS cannot see it);
 * 3. keeps future audit/retry changes in one place.
 *
 * Note: the `method` / `event` parameter types are allowlist unions
 * (`shared/ipc-contract.ts`): a misspelled name at the call site (e.g.
 * 'ui.panel.lst') fails at compile time instead of being rejected at runtime.
 */

import type { AllowedEvent, AllowedMethod } from '../../shared/ipc-contract'

/** Shape of the object exposed by preload via contextBridge (kept in sync with host/electron/preload.ts). */
export interface Rem2Bridge {
  invoke(method: string, args?: unknown): Promise<unknown>
  onEvent(event: string, handler: (payload: unknown) => void): () => void
}

declare global {
  interface Window {
    rem2?: Rem2Bridge
  }
}

export interface IpcClient {
  request<T>(method: AllowedMethod, args?: unknown): Promise<T>
  /** Subscribe to an allowlisted event; returns an unsubscribe function (for `$effect` cleanup). */
  subscribe(
    event: AllowedEvent,
    handler: (payload: unknown) => void,
  ): () => void
  /** Whether the preload bridge is available (false in a plain browser or under tests). */
  readonly available: boolean
}

/** Active subscription count; enables a unified unsubscribe on `beforeunload` (R8 leak mitigation). */
let activeSubscriptions = 0

export const ipc: IpcClient = {
  get available(): boolean {
    return typeof window !== 'undefined' && !!window.rem2
  },

  async request<T>(method: AllowedMethod, args?: unknown): Promise<T> {
    if (!window.rem2) {
      throw new Error('preload bridge unavailable (REM2_BRIDGE_MISSING)')
    }
    return (await window.rem2.invoke(method, args)) as T
  },

  subscribe(
    event: AllowedEvent,
    handler: (payload: unknown) => void,
  ): () => void {
    if (!window.rem2) return () => undefined
    activeSubscriptions += 1
    const off = window.rem2.onEvent(event, handler)
    return () => {
      activeSubscriptions -= 1
      off()
    }
  },
}

/** Current number of active subscriptions (for tests/debugging). */
export function subscriptionCount(): number {
  return activeSubscriptions
}
