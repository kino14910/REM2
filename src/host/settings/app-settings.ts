import {
  DEFAULT_APPEARANCE_SETTINGS,
  normalizeAppearanceSettings,
  type AppearanceSettings,
} from './appearance-settings.js'
import {
  DEFAULT_PROXY_SETTINGS,
  normalizeProxySettings,
  ProxySettingsError,
  type ProxySettings,
} from './proxy-settings.js'

/** Version of the unified `settings.json` document, owned by the app (not electron-store). */
export const SETTINGS_SCHEMA_VERSION = 1 as const

export interface AppSettingsDocument {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION
  proxy: ProxySettings
  appearance: AppearanceSettings
}

/** Defaults are derived from the domain defaults; electron-store's `defaults`/schema are not used. */
export function defaultAppSettingsDocument(): AppSettingsDocument {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    proxy: { ...DEFAULT_PROXY_SETTINGS },
    appearance: { ...DEFAULT_APPEARANCE_SETTINGS },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate the persisted document structure, then run the same business
 * normalization as IPC input (address parsing, field cleanup, cross-field rules).
 * An unknown `schemaVersion` is rejected instead of guessed at or downgraded.
 */
export function parseAppSettingsDocument(value: unknown): AppSettingsDocument {
  if (!isRecord(value)) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'settings must be an object',
    )
  }
  if (value.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      `settings schemaVersion must be ${SETTINGS_SCHEMA_VERSION}`,
    )
  }
  if (!('proxy' in value)) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'settings must contain a proxy block',
    )
  }
  if (!('appearance' in value)) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'settings must contain an appearance block',
    )
  }
  try {
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      proxy: normalizeProxySettings(value.proxy),
      appearance: normalizeAppearanceSettings(value.appearance),
    }
  } catch (error) {
    if (error instanceof ProxySettingsError) throw error
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'settings contain invalid values',
      { cause: error },
    )
  }
}

/** Validate the legacy `proxy-settings.json` shape (`{ version: 1, proxy }`). */
export function parseLegacyProxySettings(value: unknown): ProxySettings {
  if (!isRecord(value) || value.version !== 1 || !('proxy' in value)) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'legacy proxy settings must be { version: 1, proxy }',
    )
  }
  return normalizeProxySettings(value.proxy)
}

/** Validate the legacy `appearance-settings.json` shape (`{ version: 1, colorMode }`). */
export function parseLegacyAppearanceSettings(
  value: unknown,
): AppearanceSettings {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error(
      'legacy appearance settings must be { version: 1, colorMode }',
    )
  }
  return normalizeAppearanceSettings(value)
}
