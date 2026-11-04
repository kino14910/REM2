/**
 * Runtime validation for IPC method args.
 *
 * Args arriving from the renderer are untrusted at runtime (the preload
 * bridge is a plain JS surface). This module is the host-side boundary
 * guard: pure functions, no imports, so it stays trivially testable and
 * cannot drag kernel/host dependencies into the validation path.
 *
 * Policy: invalid args throw (the bridge turns that into an error reply and
 * the frontend renders its error state) - never a silent coercion, which
 * once let `String(themeId ?? '')` swallow a malformed request into a
 * meaningless empty-string lookup.
 */

import { isSha256 } from '@/host/plugins/integrity.js'
import {
  normalizeAppearanceSettings,
  type AppearanceSettings,
} from '@/host/settings/appearance-settings.js'
import {
  normalizeLoggingSettings,
  type LoggingSettings,
} from '@/host/settings/logging-settings.js'
import {
  normalizeProxySettings,
  type ProxySettings,
} from '@/host/settings/proxy-settings.js'
import { isValidPluginId } from '@/kernel/discovery/manifest-validator.js'
import { isValidVersion } from '@/kernel/semver/semver.js'

const MAX_URL_LENGTH = 2048
const OPERATION_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/

/** Narrows unknown args to an object or throws with an explicit message. */
function asObject(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('invalid args: expected an object')
  }
  return args as Record<string, unknown>
}

/** Reads a required non-empty string field or throws naming the field. */
function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid args: expected { ${field}: non-empty string }`)
  }
  return value
}

/** Validates `{ panelId: string }` and returns the panel id. */
export function panelIdOf(args: unknown): string {
  return nonEmptyString(asObject(args).panelId, 'panelId')
}

/**
 * Validates `{ panelId, kind, payload? }` for `ui.event`.
 *
 * `payload` is plugin-defined and passes through untouched (`unknown`).
 */
export function uiEventArgsOf(args: unknown): {
  panelId: string
  kind: string
  payload?: unknown
} {
  const obj = asObject(args)
  const panelId = nonEmptyString(obj.panelId, 'panelId')
  const kind = nonEmptyString(obj.kind, 'kind')
  return obj.payload === undefined
    ? { panelId, kind }
    : { panelId, kind, payload: obj.payload }
}

/** Validates `{ themeId: string }` and returns the theme id. */
export function themeIdOf(args: unknown): string {
  return nonEmptyString(asObject(args).themeId, 'themeId')
}

/** Longest accepted CSS color literal (a computed `rgb()` / `color()` value fits well below this). */
const MAX_CSS_COLOR_LENGTH = 64

function cssColor(value: unknown, field: string): string {
  const color = nonEmptyString(value, field).trim()
  if (color.length === 0 || color.length > MAX_CSS_COLOR_LENGTH) {
    throw new Error(
      `invalid args: ${field} must be a CSS color (1-${MAX_CSS_COLOR_LENGTH} characters)`,
    )
  }
  return color
}

/** Validates `{ color, symbolColor }` for the native title bar overlay. */
export function titleBarColorsOf(args: unknown): {
  color: string
  symbolColor: string
} {
  const obj = asObject(args)
  return {
    color: cssColor(obj.color, 'color'),
    symbolColor: cssColor(obj.symbolColor, 'symbolColor'),
  }
}

export function pluginIdOf(args: unknown): string {
  const pluginId = nonEmptyString(asObject(args).pluginId, 'pluginId')
  if (!isValidPluginId(pluginId)) {
    throw new Error('invalid args: pluginId has an invalid format')
  }
  return pluginId
}

/** Capability names follow the manifest grammar; max 64 per request. */
const CAPABILITY_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/
const MAX_GRANTED_CAPABILITIES = 64

function capabilitiesOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      'invalid args: expected { capabilities: non-empty string[] }',
    )
  }
  if (value.length > MAX_GRANTED_CAPABILITIES) {
    throw new Error(
      `invalid args: capabilities must contain at most ${MAX_GRANTED_CAPABILITIES} entries`,
    )
  }
  const capabilities = value.map(capability => {
    if (typeof capability !== 'string' || !CAPABILITY_RE.test(capability)) {
      throw new Error(
        'invalid args: capabilities must be valid capability names',
      )
    }
    return capability
  })
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error('invalid args: duplicate capability')
  }
  return capabilities
}

/** Validates `{ pluginId, capabilities: string[] }` for `plugin.permission.grant`. */
export function permissionGrantArgsOf(args: unknown): {
  pluginId: string
  capabilities: string[]
} {
  const obj = asObject(args)
  return {
    pluginId: pluginIdOf(obj),
    capabilities: capabilitiesOf(obj.capabilities),
  }
}

/**
 * Validates `{ pluginId, capabilities? }` for `plugin.enable`.
 * Capabilities turn this into the single-consent "grant and enable" path.
 */
export function pluginEnableArgsOf(args: unknown): {
  pluginId: string
  capabilities?: string[]
} {
  const obj = asObject(args)
  const pluginId = pluginIdOf(obj)
  return obj.capabilities === undefined
    ? { pluginId }
    : { pluginId, capabilities: capabilitiesOf(obj.capabilities) }
}

export function noArgsOf(args: unknown): void {
  if (args !== undefined) throw new Error('invalid args: expected no arguments')
}

/** Validates `{ mode, address?, bypass? }` for `settings.proxy.set`. */
export function proxySettingsArgsOf(args: unknown): ProxySettings {
  return normalizeProxySettings(asObject(args))
}

/** Validates `{ colorMode }` for `settings.appearance.set`. */
export function appearanceSettingsArgsOf(args: unknown): AppearanceSettings {
  return normalizeAppearanceSettings(asObject(args))
}

/** Validates `{ enabled, level }` for `settings.logging.set`. */
export function loggingSettingsArgsOf(args: unknown): LoggingSettings {
  return normalizeLoggingSettings(asObject(args))
}

/**
 * Validates `{ url }` for remote sources: HTTPS only, bounded length.
 * Host allowlisting happens later in the downloader, not here.
 */
export function remoteUrlOf(args: unknown, field = 'url'): string {
  const value = nonEmptyString(asObject(args)[field], field)
  if (value.length > MAX_URL_LENGTH) {
    throw new Error(
      `invalid args: ${field} must be at most ${MAX_URL_LENGTH} characters`,
    )
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`invalid args: ${field} must be a valid URL`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(`invalid args: ${field} must use https`)
  }
  return value
}

/** Validates `{ operationId }` (renderer-generated; used for progress and cancellation). */
export function operationIdOf(args: unknown): string {
  const value = nonEmptyString(asObject(args).operationId, 'operationId')
  if (!OPERATION_ID_RE.test(value)) {
    throw new Error(
      'invalid args: operationId must be 1..64 characters of [A-Za-z0-9._:-]',
    )
  }
  return value
}

/** Validates `{ url, operationId? }` for remote inspection. */
export function inspectRemoteArgsOf(args: unknown): {
  url: string
  operationId?: string
} {
  const obj = asObject(args)
  const url = remoteUrlOf(obj)
  return obj.operationId === undefined
    ? { url }
    : { url, operationId: operationIdOf(obj) }
}

/** Validates `{ operationId, url, sha256?, capabilities? }` for remote installation. */
export function installRemoteArgsOf(args: unknown): {
  operationId: string
  url: string
  sha256?: string
  capabilities?: string[]
} {
  const obj = asObject(args)
  const operationId = operationIdOf(obj)
  const url = remoteUrlOf(obj)
  const capabilities =
    obj.capabilities === undefined
      ? undefined
      : capabilitiesOf(obj.capabilities)
  if (obj.sha256 === undefined) {
    return {
      operationId,
      url,
      ...(capabilities ? { capabilities } : {}),
    }
  }
  if (!isSha256(obj.sha256)) {
    throw new Error(
      'invalid args: sha256 must be exactly 64 hexadecimal characters',
    )
  }
  return {
    operationId,
    url,
    sha256: obj.sha256.toLowerCase(),
    ...(capabilities ? { capabilities } : {}),
  }
}

/** Validates `{ pluginId? }` for update checks. */
export function updateCheckArgsOf(args: unknown): { pluginId?: string } {
  if (args === undefined) return {}
  const obj = asObject(args)
  if (obj.pluginId === undefined) return {}
  const pluginId = nonEmptyString(obj.pluginId, 'pluginId')
  if (!isValidPluginId(pluginId)) {
    throw new Error('invalid args: pluginId has an invalid format')
  }
  return { pluginId }
}

/**
 * Validates `{ operationId, pluginId, expectedVersion, expectedSha256 }` for
 * applying an update. The expected values bind execution to what the user saw.
 */
export function updateInstallArgsOf(args: unknown): {
  operationId: string
  pluginId: string
  expectedVersion: string
  expectedSha256: string
} {
  const obj = asObject(args)
  const expectedVersion = nonEmptyString(obj.expectedVersion, 'expectedVersion')
  if (expectedVersion.length > 128) {
    throw new Error(
      'invalid args: expectedVersion must be at most 128 characters',
    )
  }
  if (!isSha256(obj.expectedSha256)) {
    throw new Error(
      'invalid args: expectedSha256 must be exactly 64 hexadecimal characters',
    )
  }
  return {
    operationId: operationIdOf(obj),
    pluginId: pluginIdOf(obj),
    expectedVersion,
    expectedSha256: obj.expectedSha256.toLowerCase(),
  }
}

/** Validates `{ refresh?: boolean }` for marketplace reads. */
export function marketListArgsOf(args: unknown): { refresh?: boolean } {
  if (args === undefined) return {}
  const obj = asObject(args)
  if (obj.refresh === undefined) return {}
  if (typeof obj.refresh !== 'boolean') {
    throw new Error('invalid args: refresh must be a boolean')
  }
  return { refresh: obj.refresh }
}

/**
 * Validates `{ operationId, pluginId, version }` for a marketplace install or
 * update. The host re-resolves the registry by id + version; no URL or digest
 * is accepted from the renderer.
 */
export function marketTargetArgsOf(args: unknown): {
  operationId: string
  pluginId: string
  version: string
} {
  const obj = asObject(args)
  const version = nonEmptyString(obj.version, 'version')
  if (version.length > 128 || !isValidVersion(version)) {
    throw new Error('invalid args: version must be a semver version')
  }
  return {
    operationId: operationIdOf(obj),
    pluginId: pluginIdOf(obj),
    version,
  }
}
