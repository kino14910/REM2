import type { ProxySettingsDto } from '@/shared/ipc-contract.js'

import type { ProxySettings } from './proxy-settings.js'

/**
 * Host-side proxy settings service consumed by the IPC method table.
 *
 * Kept electron-free (interface only) so `method-handlers.ts` stays importable
 * by vitest; the Electron implementation lives in `host/electron`.
 */
export interface ProxySettingsService {
  /** Current settings plus the proxy Chromium actually resolves. */
  get(): Promise<ProxySettingsDto>
  /** Apply and persist new settings; returns the resulting state. */
  set(settings: ProxySettings): Promise<ProxySettingsDto>
}
