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

export interface AppSettingsRecovery {
  document: AppSettingsDocument
  /** At least one namespace was missing or invalid and fell back to its defaults. */
  damaged: boolean
}

/**
 * Recover a persisted document one namespace at a time.
 *
 * A document-level problem (not an object, or an unknown `schemaVersion`) still
 * rejects the whole file: the semantics of a newer layout cannot be guessed.
 * Once the version is known, a damaged `proxy` block must not discard a valid
 * `appearance` value (and vice versa); the damaged side alone falls back to its
 * domain default and the caller preserves the original file for diagnosis.
 */
export function recoverAppSettingsDocument(
  value: unknown,
): AppSettingsRecovery {
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

  let proxy: ProxySettings | undefined
  let appearance: AppearanceSettings | undefined
  let firstError: unknown

  if ('proxy' in value) {
    try {
      proxy = normalizeProxySettings(value.proxy)
    } catch (error) {
      firstError ??= error
    }
  } else {
    firstError ??= new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'settings must contain a proxy block',
    )
  }

  if ('appearance' in value) {
    try {
      appearance = normalizeAppearanceSettings(value.appearance)
    } catch (error) {
      firstError ??= error
    }
  } else {
    firstError ??= new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'settings must contain an appearance block',
    )
  }

  if (proxy === undefined && appearance === undefined) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'settings contain no valid namespace',
      { cause: firstError },
    )
  }

  return {
    document: {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      proxy: proxy ?? { ...DEFAULT_PROXY_SETTINGS },
      appearance: appearance ?? { ...DEFAULT_APPEARANCE_SETTINGS },
    },
    damaged: proxy === undefined || appearance === undefined,
  }
}

/**
 * Strict whole-document parse used before seeding a fresh file. An unknown
 * `schemaVersion` is rejected instead of guessed at or downgraded.
 */
export function parseAppSettingsDocument(value: unknown): AppSettingsDocument {
  const recovered = recoverAppSettingsDocument(value)
  if (recovered.damaged) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'settings contain an invalid namespace',
    )
  }
  return recovered.document
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
