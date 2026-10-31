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

import { isValidPluginId } from '../../kernel/discovery/manifest-validator.js'
import { isSha256 } from '../plugins/integrity.js'

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

/** Validates `{ pluginId, capabilities: string[] }` for `plugin.permission.grant`. */
export function permissionGrantArgsOf(args: unknown): {
  pluginId: string
  capabilities: string[]
} {
  const obj = asObject(args)
  const pluginId = pluginIdOf(obj)
  if (!Array.isArray(obj.capabilities) || obj.capabilities.length === 0) {
    throw new Error(
      'invalid args: expected { capabilities: non-empty string[] }',
    )
  }
  if (obj.capabilities.length > MAX_GRANTED_CAPABILITIES) {
    throw new Error(
      `invalid args: capabilities must contain at most ${MAX_GRANTED_CAPABILITIES} entries`,
    )
  }
  const capabilities = obj.capabilities.map(capability => {
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
  return { pluginId, capabilities }
}

export function noArgsOf(args: unknown): void {
  if (args !== undefined) throw new Error('invalid args: expected no arguments')
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

/** Validates `{ operationId, url, sha256? }` for remote installation. */
export function installRemoteArgsOf(args: unknown): {
  operationId: string
  url: string
  sha256?: string
} {
  const obj = asObject(args)
  const operationId = operationIdOf(obj)
  const url = remoteUrlOf(obj)
  if (obj.sha256 === undefined) return { operationId, url }
  if (!isSha256(obj.sha256)) {
    throw new Error(
      'invalid args: sha256 must be exactly 64 hexadecimal characters',
    )
  }
  return { operationId, url, sha256: obj.sha256.toLowerCase() }
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

/** Validates `{ operationId, pluginId }` for applying an update. */
export function updateInstallArgsOf(args: unknown): {
  operationId: string
  pluginId: string
} {
  const obj = asObject(args)
  return {
    operationId: operationIdOf(obj),
    pluginId: pluginIdOf(obj),
  }
}
