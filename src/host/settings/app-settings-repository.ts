import type { AppearanceSettings } from './appearance-settings.js'
import type { ProxySettings } from './proxy-settings.js'

/**
 * Electron-free repository contracts for the app-level `settings.json`.
 *
 * Kept async even though electron-store is synchronous, so the services and
 * tests never depend on the storage engine's execution model. The implementation
 * must validate before persisting and publish in-memory state only afterwards.
 */
export interface ProxySettingsRepository {
  /** Load once; a corrupt file degrades to defaults without clearing it. */
  load(): Promise<void>
  /** Current persisted proxy settings (copy). */
  getProxy(): ProxySettings
  /** Validate, persist only the proxy namespace, then publish it. */
  setProxy(value: unknown): Promise<void>
}

export interface AppearanceSettingsRepository {
  /** Load once; a corrupt file degrades to defaults without clearing it. */
  load(): Promise<void>
  /** Current persisted appearance settings (copy). */
  getAppearance(): AppearanceSettings
  /** Validate, persist only the appearance namespace, then publish it. */
  setAppearance(value: unknown): Promise<AppearanceSettings>
}

export interface AppSettingsRepository
  extends ProxySettingsRepository, AppearanceSettingsRepository {}
