import type {
  ProxyModeDto,
  ProxySettingsDto,
} from '@/shared/ipc-contract.js'

/** Persisted proxy settings; `resolved` is a runtime diagnostic and never stored. */
export type ProxySettings = Omit<ProxySettingsDto, 'resolved'>

/**
 * Structural subset of Electron's `ProxyConfig`, kept electron-free so the
 * mapping stays unit-testable outside the main process.
 */
export interface ProxyConfigLike {
  mode: 'system' | 'direct' | 'fixed_servers'
  proxyRules?: string
  proxyBypassRules?: string
}

/** `E_SETTINGS_*` codes reach the renderer through the IPC bridge. */
export type ProxySettingsErrorCode =
  | 'E_SETTINGS_INVALID'
  | 'E_SETTINGS_WRITE'
  | 'E_SETTINGS_UNAVAILABLE'

export class ProxySettingsError extends Error {
  constructor(
    readonly code: ProxySettingsErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ProxySettingsError'
  }
}

const MAX_FIELD_LENGTH = 512
const MODES: readonly ProxyModeDto[] = ['system', 'direct', 'manual']

/** Chromium proxy rules are a single line; control characters can corrupt them. */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export const DEFAULT_PROXY_SETTINGS: ProxySettings = { mode: 'system' }

/**
 * Parse a manual proxy address.
 *
 * Accepts `host:port`, `http://host:port` and `https://host:port`; a missing
 * port falls back to 80/443. Credentials, paths, queries and fragments are
 * rejected because Chromium's proxy rules cannot express them (proxy auth needs
 * the session `login` event instead).
 */
export function parseProxyAddress(value: string): {
  scheme: 'http' | 'https'
  host: string
  port: number
} {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'proxy address must not be empty',
    )
  }
  if (trimmed.length > MAX_FIELD_LENGTH) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      `proxy address must be at most ${MAX_FIELD_LENGTH} characters`,
    )
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch (error) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'proxy address must be a valid host:port or URL',
      { cause: error },
    )
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'proxy address must use http:// or https://',
    )
  }
  if (url.username || url.password) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'proxy address must not contain credentials',
    )
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'proxy address must not contain a path, query or fragment',
    )
  }
  if (!url.hostname) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'proxy address must include a host',
    )
  }
  const port = url.port
    ? Number(url.port)
    : url.protocol === 'https:'
      ? 443
      : 80
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'proxy address port must be 1..65535',
    )
  }
  return {
    scheme: url.protocol === 'https:' ? 'https' : 'http',
    host: url.hostname,
    port,
  }
}

/** Normalize untrusted settings (persisted file or IPC args) into the stored shape. */
export function normalizeProxySettings(value: unknown): ProxySettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'proxy settings must be an object',
    )
  }
  const record = value as Record<string, unknown>
  const mode = record.mode
  if (typeof mode !== 'string' || !MODES.includes(mode as ProxyModeDto)) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'proxy mode must be "system", "direct" or "manual"',
    )
  }
  if (mode !== 'manual') return { mode: mode as ProxyModeDto }

  const rawAddress = record.address
  if (typeof rawAddress !== 'string' || rawAddress.trim().length === 0) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'manual proxy mode requires a non-empty address',
    )
  }
  const { scheme, host, port } = parseProxyAddress(rawAddress)
  const bypass = normalizeBypass(record.bypass)
  return {
    mode: 'manual',
    address: `${scheme}://${host}:${port}`,
    ...(bypass ? { bypass } : {}),
  }
}

function normalizeBypass(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'proxy bypass rules must be a string',
    )
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length > MAX_FIELD_LENGTH) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      `proxy bypass rules must be at most ${MAX_FIELD_LENGTH} characters`,
    )
  }
  if (hasControlCharacters(trimmed)) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'proxy bypass rules must not contain control characters',
    )
  }
  return trimmed
}

/** Map stored settings to the subset of Electron's `ProxyConfig` the app uses. */
export function toProxyConfig(settings: ProxySettings): ProxyConfigLike {
  if (settings.mode === 'system') return { mode: 'system' }
  if (settings.mode === 'direct') return { mode: 'direct' }
  if (!settings.address) {
    throw new ProxySettingsError(
      'E_SETTINGS_INVALID',
      'manual proxy mode requires an address',
    )
  }
  const { scheme, host, port } = parseProxyAddress(settings.address)
  const address = `${scheme}://${host}:${port}`
  return {
    mode: 'fixed_servers',
    proxyRules: `http=${address};https=${address}`,
    ...(settings.bypass ? { proxyBypassRules: settings.bypass } : {}),
  }
}
