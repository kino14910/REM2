export type RegistryClientErrorCode =
  | 'E_REGISTRY_SOURCE_INVALID'
  | 'E_REGISTRY_NETWORK'
  | 'E_REGISTRY_TIMEOUT'
  | 'E_REGISTRY_CANCELLED'
  | 'E_REGISTRY_HTTP'
  | 'E_REGISTRY_TOO_LARGE'
  | 'E_REGISTRY_PARSE'
  | 'E_REGISTRY_SCHEMA'
  | 'E_REGISTRY_SCHEMA_VERSION'
  | 'E_REGISTRY_CACHE'
  | 'E_REGISTRY_COMPATIBILITY'

/**
 * Every registry failure carries a code, so callers can distinguish
 * "network is down" (cache fallback allowed) from "the remote index is
 * malformed" (must be surfaced, never silently replaced by stale data).
 */
export class RegistryClientError extends Error {
  constructor(
    readonly code: RegistryClientErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RegistryClientError'
  }
}

export function isRegistryClientError(
  value: unknown,
): value is RegistryClientError {
  return value instanceof RegistryClientError
}

/** Only transport-level failures may fall back to the last successful index. */
export function isRegistryNetworkFailure(
  value: unknown,
): value is RegistryClientError {
  return (
    isRegistryClientError(value) &&
    (value.code === 'E_REGISTRY_NETWORK' ||
      value.code === 'E_REGISTRY_TIMEOUT' ||
      value.code === 'E_REGISTRY_HTTP')
  )
}
