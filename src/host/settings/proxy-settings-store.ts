import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  DEFAULT_PROXY_SETTINGS,
  normalizeProxySettings,
  ProxySettingsError,
  type ProxySettings,
} from './proxy-settings.js'

interface PersistedSettings {
  version: 1
  proxy: ProxySettings
}

/**
 * Host-wide app settings that must be available before any network request.
 *
 * Only the proxy block exists today, but the file is versioned (`settings.json`
 * semantics without committing to a name) so future host settings can join it
 * without a second file.
 */
export class ProxySettingsStore {
  private settings: ProxySettings = { ...DEFAULT_PROXY_SETTINGS }
  private loaded = false

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.loaded = true
      return
    }

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      throw new ProxySettingsError(
        'E_SETTINGS_INVALID',
        'proxy settings are not valid JSON',
        { cause: error },
      )
    }
    if (
      typeof raw !== 'object' ||
      raw === null ||
      Array.isArray(raw) ||
      (raw as PersistedSettings).version !== 1 ||
      !('proxy' in raw)
    ) {
      throw new ProxySettingsError(
        'E_SETTINGS_INVALID',
        'proxy settings must be { version: 1, proxy: ProxySettings }',
      )
    }
    this.settings = normalizeProxySettings((raw as PersistedSettings).proxy)
    this.loaded = true
  }

  /** Current settings (copy; the caller cannot mutate store state). */
  get(): ProxySettings {
    return { ...this.settings }
  }

  /** Validate, persist atomically and only then publish the new value. */
  async set(value: unknown): Promise<void> {
    const next = normalizeProxySettings(value)
    const previous = this.settings
    try {
      await this.persist(next)
    } catch (error) {
      this.settings = previous
      throw error
    }
    this.settings = next
  }

  private async persist(settings: ProxySettings): Promise<void> {
    const state: PersistedSettings = { version: 1, proxy: settings }
    const dir = path.dirname(this.filePath)
    const temp = path.join(
      dir,
      `.proxy-settings-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    )
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      })
      await rename(temp, this.filePath)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw new ProxySettingsError(
        'E_SETTINGS_WRITE',
        'failed to persist proxy settings',
        { cause: error },
      )
    }
  }
}
