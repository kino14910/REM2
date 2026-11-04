import type {
  LoggingSettingsDto,
  ProxySettingsDto,
} from '@/shared/ipc-contract'

import {
  parseLoggingSettings,
  parseProxySettings,
} from '@/frontend/lib/dto-guards'
import { ipc } from '@/frontend/lib/ipc-client'
import { channels } from '@/shared/ipc-contract'

/** Stable host codes -> readable text; the raw code stays in the message. */
const SETTINGS_ERROR_TEXT: Record<string, string> = {
  E_SETTINGS_INVALID: 'The proxy settings are invalid.',
  E_SETTINGS_WRITE: 'The proxy settings could not be saved.',
  E_SETTINGS_UNAVAILABLE: 'Proxy settings are unavailable in this host.',
  E_CONFIRMATION_DENIED:
    'The proxy change was cancelled at the system confirmation.',
  E_CONFIRMATION_UNAVAILABLE:
    'This host cannot display the required proxy confirmation dialog.',
}

const LOGGING_ERROR_TEXT: Record<string, string> = {
  E_SETTINGS_INVALID: 'The logging settings are invalid.',
  E_SETTINGS_WRITE: 'The logging settings could not be saved.',
  E_SETTINGS_UNAVAILABLE: 'Logging settings are unavailable in this host.',
}

function formatSettingsError(
  texts: Record<string, string>,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code !== 'string') return message
  const text = texts[code]
  return text ? `${text} (${code})` : `${message} (${code})`
}

function settingsErrorText(error: unknown): string {
  return formatSettingsError(SETTINGS_ERROR_TEXT, error)
}

function loggingErrorText(error: unknown): string {
  return formatSettingsError(LOGGING_ERROR_TEXT, error)
}

class SettingsStore {
  /** Last settings confirmed by the host (defaults match the host's default). */
  proxy = $state<ProxySettingsDto>({ mode: 'system' })
  /** Console logging settings confirmed by the host (defaults match the host). */
  logging = $state<LoggingSettingsDto>({ enabled: true, level: 'info' })
  loading = $state(false)
  saving = $state(false)
  loggingSaving = $state(false)
  error = $state<string | undefined>(undefined)
  notice = $state<string | undefined>(undefined)

  async load(): Promise<void> {
    this.loading = true
    try {
      this.proxy = parseProxySettings(
        await ipc.request<ProxySettingsDto>(channels.settingsProxyGet),
      )
      this.error = undefined
    } catch (error) {
      this.error = settingsErrorText(error)
    } finally {
      this.loading = false
    }
  }

  async loadLogging(): Promise<void> {
    try {
      this.logging = parseLoggingSettings(
        await ipc.request<LoggingSettingsDto>(channels.settingsLoggingGet),
      )
    } catch (error) {
      this.error = loggingErrorText(error)
    }
  }

  async save(next: ProxySettingsDto): Promise<void> {
    this.saving = true
    this.error = undefined
    this.notice = undefined
    try {
      const result = parseProxySettings(
        await ipc.request<ProxySettingsDto>(channels.settingsProxySet, {
          mode: next.mode,
          ...(next.address !== undefined ? { address: next.address } : {}),
          ...(next.bypass !== undefined ? { bypass: next.bypass } : {}),
        }),
      )
      this.proxy = result
      this.notice = 'Proxy settings applied.'
    } catch (error) {
      this.error = settingsErrorText(error)
    } finally {
      this.saving = false
    }
  }

  async saveLogging(next: LoggingSettingsDto): Promise<void> {
    this.loggingSaving = true
    this.error = undefined
    this.notice = undefined
    try {
      const result = parseLoggingSettings(
        await ipc.request<LoggingSettingsDto>(channels.settingsLoggingSet, {
          enabled: next.enabled,
          level: next.level,
        }),
      )
      this.logging = result
      this.notice = 'Logging settings applied.'
    } catch (error) {
      this.error = loggingErrorText(error)
    } finally {
      this.loggingSaving = false
    }
  }

  clearNotice(): void {
    this.notice = undefined
  }
}

export const appSettings = new SettingsStore()
