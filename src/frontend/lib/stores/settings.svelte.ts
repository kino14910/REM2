import { channels } from '@/shared/ipc-contract'
import type { ProxySettingsDto } from '@/shared/ipc-contract'
import { parseProxySettings } from '@/frontend/lib/dto-guards'
import { ipc } from '@/frontend/lib/ipc-client'

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

function settingsErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code !== 'string') return message
  const text = SETTINGS_ERROR_TEXT[code]
  return text ? `${text} (${code})` : `${message} (${code})`
}

class SettingsStore {
  /** Last settings confirmed by the host (defaults match the host's default). */
  proxy = $state<ProxySettingsDto>({ mode: 'system' })
  loading = $state(false)
  saving = $state(false)
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

  clearNotice(): void {
    this.notice = undefined
  }
}

export const appSettings = new SettingsStore()
