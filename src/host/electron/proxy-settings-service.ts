import type { Session } from 'electron'

import type { ProxySettingsRepository } from '@/host/settings/app-settings-repository.js'
import type { ProxySettingsService } from '@/host/settings/proxy-settings-service.js'
import type { ProxySettingsDto } from '@/shared/ipc-contract.js'

import {
  normalizeProxySettings,
  ProxySettingsError,
  toProxyConfig,
  type ProxySettings,
} from '@/host/settings/proxy-settings.js'

/** Resolved through Chromium so the UI can show which proxy is actually in effect. */
const RESOLVE_URL = 'https://api.github.com/'

/**
 * Electron implementation: persist settings and apply them to the default
 * session, which is what `net.fetch` / window requests / plugin downloads use.
 */
export class ElectronProxySettingsService implements ProxySettingsService {
  private operationQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly electronSession: Session,
    private readonly store: ProxySettingsRepository,
  ) {}

  /** Load before any network use, then apply; a corrupt file degrades to the system default. */
  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      try {
        await this.store.load()
      } catch (error) {
        console.error('[rem2-kernel] App settings failed to load:', error)
      }
      await this.electronSession.setProxy(toProxyConfig(this.store.getProxy()))
    })
  }

  async get(): Promise<ProxySettingsDto> {
    return await this.enqueue(async () => await this.snapshot())
  }

  async set(settings: ProxySettings): Promise<ProxySettingsDto> {
    return await this.enqueue(async () => {
      const previous = this.store.getProxy()
      const next = normalizeProxySettings(settings)
      await this.electronSession.setProxy(toProxyConfig(next))
      try {
        await this.store.setProxy(next)
      } catch (error) {
        // Keep the in-memory session consistent with the persisted value.
        try {
          await this.electronSession.setProxy(toProxyConfig(previous))
        } catch (rollbackError) {
          throw new ProxySettingsError(
            'E_SETTINGS_UNAVAILABLE',
            'failed to persist proxy settings; rolling back the Electron session proxy also failed',
            { cause: rollbackError },
          )
        }
        throw error
      }
      return await this.snapshot()
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation)
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async snapshot(): Promise<ProxySettingsDto> {
    const settings = this.store.getProxy()
    let resolved: string | undefined
    try {
      const value = await this.electronSession.resolveProxy(RESOLVE_URL)
      if (value.trim().length > 0) resolved = value.trim()
    } catch {
      // Diagnostics only; a platform without resolveProxy still works.
    }
    return { ...settings, ...(resolved ? { resolved } : {}) }
  }
}
