import ElectronStore from 'electron-store'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import path from 'node:path'

import type { AppSettingsRepository } from '@/host/settings/app-settings-repository.js'

import {
  defaultAppSettingsDocument,
  parseAppSettingsDocument,
  parseLegacyAppearanceSettings,
  parseLegacyProxySettings,
  recoverAppSettingsDocument,
  SETTINGS_SCHEMA_VERSION,
  type AppSettingsDocument,
  type AppSettingsRecovery,
} from '@/host/settings/app-settings.js'
import {
  DEFAULT_APPEARANCE_SETTINGS,
  normalizeAppearanceSettings,
  type AppearanceSettings,
} from '@/host/settings/appearance-settings.js'
import {
  DEFAULT_PROXY_SETTINGS,
  normalizeProxySettings,
  ProxySettingsError,
  type ProxySettings,
} from '@/host/settings/proxy-settings.js'

const PROXY_WRITE_MESSAGE = 'failed to persist proxy settings'
const APPEARANCE_WRITE_MESSAGE = 'failed to persist appearance settings'

/**
 * The only electron-store consumer. Main creates one instance and exposes it to
 * the existing proxy service / appearance service; renderer, preload, plugins
 * and kernel modules never import this file.
 *
 * electron-store is intentionally used without `defaults`, `schema`, `watch`,
 * `migrations` or `encryptionKey`: defaults live in the domain modules, the
 * document version is explicit, and concurrent multi-process writes are out of
 * scope. `clearInvalidConfig: false` keeps a damaged file intact for diagnosis.
 */
export class ElectronAppSettingsStore implements AppSettingsRepository {
  private store: ElectronStore<AppSettingsDocument> | null = null
  private settings: AppSettingsDocument = defaultAppSettingsDocument()
  private loaded = false
  /** The unified file is missing or was rejected, so the next write must seed the whole document. */
  private baseWritePending = true
  /** The file exists but is damaged/unsupported; back it up before the first write. */
  private invalidFile = false

  private readonly settingsPath: string
  private readonly legacyProxyPath: string
  private readonly legacyAppearancePath: string

  constructor(private readonly directory: string) {
    this.settingsPath = path.join(directory, 'settings.json')
    this.legacyProxyPath = path.join(directory, 'proxy-settings.json')
    this.legacyAppearancePath = path.join(directory, 'appearance-settings.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true

    if (existsSync(this.settingsPath)) {
      let recovered: AppSettingsRecovery
      let store: ElectronStore<AppSettingsDocument>
      try {
        store = this.createStore()
        recovered = recoverAppSettingsDocument(store.store)
      } catch (error) {
        this.settings = defaultAppSettingsDocument()
        this.invalidFile = true
        this.baseWritePending = true
        this.store = null
        throw invalidSettingsError(error)
      }

      this.store = store
      this.settings = recovered.document
      if (recovered.damaged) {
        // Keep the valid namespace in memory, but treat the file as damaged:
        // the original is backed up before the first write replaces it.
        this.invalidFile = true
        this.baseWritePending = true
        const message =
          'settings.json contains a damaged namespace; valid values were kept'
        console.error(`[rem2-kernel] ${message}`)
        throw new ProxySettingsError('E_SETTINGS_INVALID', message)
      }
      this.baseWritePending = false
      return
    }

    const legacy = this.readLegacySettings()
    this.settings = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      proxy: legacy.proxy,
      appearance: legacy.appearance,
    }
    this.baseWritePending = true
    if (legacy.found) {
      this.persistBase(this.settings, 'failed to import legacy settings')
    }
  }

  getProxy(): ProxySettings {
    return { ...this.settings.proxy }
  }

  getAppearance(): AppearanceSettings {
    return { ...this.settings.appearance }
  }

  async setProxy(value: unknown): Promise<void> {
    const next = normalizeProxySettings(value)
    if (this.baseWritePending) {
      this.persistBase({ ...this.settings, proxy: next }, PROXY_WRITE_MESSAGE)
      return
    }
    const store = this.prepareForWrite()
    try {
      store.set('proxy', next)
    } catch (error) {
      throw writeFailure(PROXY_WRITE_MESSAGE, error)
    }
    this.settings = { ...this.settings, proxy: next }
  }

  async setAppearance(value: unknown): Promise<AppearanceSettings> {
    const next = normalizeAppearanceSettings(value)
    if (this.baseWritePending) {
      this.persistBase(
        { ...this.settings, appearance: next },
        APPEARANCE_WRITE_MESSAGE,
      )
      return { ...next }
    }
    const store = this.prepareForWrite()
    try {
      store.set('appearance', next)
    } catch (error) {
      throw writeFailure(APPEARANCE_WRITE_MESSAGE, error)
    }
    this.settings = { ...this.settings, appearance: next }
    return { ...next }
  }

  /** One-time import from the two legacy files. Valid values win; bad files are logged and defaulted. */
  private readLegacySettings(): {
    proxy: ProxySettings
    appearance: AppearanceSettings
    found: boolean
  } {
    let found = false
    let proxy: ProxySettings = { ...DEFAULT_PROXY_SETTINGS }
    let appearance: AppearanceSettings = { ...DEFAULT_APPEARANCE_SETTINGS }

    if (existsSync(this.legacyProxyPath)) {
      found = true
      try {
        proxy = parseLegacyProxySettings(
          JSON.parse(readFileSync(this.legacyProxyPath, 'utf8')),
        )
      } catch (error) {
        console.error(
          '[rem2-kernel] Legacy proxy settings could not be imported:',
          error,
        )
      }
    }

    if (existsSync(this.legacyAppearancePath)) {
      found = true
      try {
        appearance = parseLegacyAppearanceSettings(
          JSON.parse(readFileSync(this.legacyAppearancePath, 'utf8')),
        )
      } catch (error) {
        console.error(
          '[rem2-kernel] Legacy appearance settings could not be imported:',
          error,
        )
      }
    }

    return { proxy, appearance, found }
  }

  /**
   * Persist the full document. Used only when the file is missing or was
   * rejected, never to replace a loaded valid file (namespace writes use
   * `store.set('proxy'|'appearance', ...)` instead).
   */
  private persistBase(document: AppSettingsDocument, message: string): void {
    const validated = parseAppSettingsDocument(document)
    const store = this.prepareForWrite()
    try {
      store.set({
        schemaVersion: validated.schemaVersion,
        proxy: validated.proxy,
        appearance: validated.appearance,
      })
    } catch (error) {
      throw writeFailure(message, error)
    }
    this.settings = validated
    this.baseWritePending = false
  }

  /** Preserve a damaged/unsupported file once, then prepare a fresh unified store. */
  private prepareForWrite(): ElectronStore<AppSettingsDocument> {
    if (this.invalidFile) {
      this.backupInvalidFile()
      this.invalidFile = false
      this.baseWritePending = true
      this.store = null
    }
    if (!this.store) this.store = this.createStore()
    return this.store
  }

  private backupInvalidFile(): void {
    if (!existsSync(this.settingsPath)) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const base = path.join(this.directory, `settings.invalid-${stamp}`)
    let candidate = `${base}.json`
    let suffix = 1
    while (existsSync(candidate)) {
      candidate = `${base}-${suffix++}.json`
    }
    try {
      renameSync(this.settingsPath, candidate)
    } catch (error) {
      throw writeFailure(
        'failed to preserve invalid settings for diagnosis',
        error,
      )
    }
    console.error(
      `[rem2-kernel] Invalid settings file preserved at ${candidate}`,
    )
  }

  private createStore(): ElectronStore<AppSettingsDocument> {
    return new ElectronStore<AppSettingsDocument>({
      cwd: this.directory,
      name: 'settings',
      clearInvalidConfig: false,
      watch: false,
    })
  }
}

function writeFailure(message: string, cause: unknown): ProxySettingsError {
  return new ProxySettingsError('E_SETTINGS_WRITE', message, { cause })
}

function invalidSettingsError(error: unknown): ProxySettingsError {
  if (
    error instanceof ProxySettingsError &&
    error.code === 'E_SETTINGS_INVALID'
  ) {
    return error
  }
  return new ProxySettingsError(
    'E_SETTINGS_INVALID',
    'settings.json is not valid',
    {
      cause: error,
    },
  )
}
