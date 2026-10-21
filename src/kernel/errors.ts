/**
 * Kernel error taxonomy: errors must be explicit, classifiable, and auditable;
 * never silently degraded.
 *
 * Convention: every kernel error extends `KernelError` and carries a stable
 * `code` for test assertions and log lookups.
 */

/** Error code enum (string union; stable and serializable). */
export type KernelErrorCode =
  | 'E_INVALID_MANIFEST'
  | 'E_DUPLICATE_ID'
  | 'E_MISSING_DEPENDENCY'
  | 'E_VERSION_MISMATCH'
  | 'E_CYCLE'
  | 'E_INCOMPATIBLE'
  | 'E_NO_PROVIDER'
  | 'E_CIRCULAR_DEPENDENCY'
  | 'E_CAPABILITY_DENIED'
  | 'E_SCOPED_ACCESS'
  | 'E_TIMEOUT'
  | 'E_LOAD_FAILED'
  | 'E_LIFECYCLE'
  | 'E_ILLEGAL_TRANSITION'
  | 'E_NO_RESPONDER'
  | 'E_NOT_WRITABLE'
  | 'E_ALREADY_STARTED'
  | 'E_MANIFEST_MISMATCH'
  | 'E_ENTRY_ESCAPE'
  | 'E_UNKNOWN_EXTENSION_POINT'
  | 'E_EXTENSION_CONFLICT'
  | 'E_GENERIC'

/** Base class of all kernel errors. */
export class KernelError extends Error {
  readonly code: KernelErrorCode
  readonly detail?: Record<string, unknown>

  constructor(
    code: KernelErrorCode,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'KernelError'
    this.code = code
    if (detail !== undefined) {
      this.detail = detail
    }
    // Restore the prototype chain (required for Error subclasses when TS targets ES2022).
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** Base class for plugin-related errors. */
export class PluginError extends KernelError {
  readonly pluginId: string

  constructor(
    code: KernelErrorCode,
    pluginId: string,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(code, `[${pluginId}] ${message}`, detail)
    this.name = 'PluginError'
    this.pluginId = pluginId
  }
}

/** Phase/operation timeout (lifecycle, RPC, etc.). */
export class TimeoutError extends KernelError {
  readonly timeoutMs: number

  constructor(
    operation: string,
    timeoutMs: number,
    detail?: Record<string, unknown>,
  ) {
    super(
      'E_TIMEOUT',
      `operation timed out: ${operation} (${timeoutMs}ms)`,
      detail,
    )
    this.name = 'TimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** Dependency resolution error (missing / version mismatch / incompatible / duplicate). */
export class ResolveError extends KernelError {
  constructor(
    code: KernelErrorCode,
    message: string,
    detail?: Record<string, unknown>,
  ) {
    super(code, message, detail)
    this.name = 'ResolveError'
  }
}

/** Circular dependency error (plugin-level or DI-level). */
export class CircularDependencyError extends KernelError {
  readonly cycle: string[]

  constructor(kind: 'plugin' | 'service', cycle: string[]) {
    super(
      kind === 'plugin' ? 'E_CYCLE' : 'E_CIRCULAR_DEPENDENCY',
      `${kind === 'plugin' ? 'plugin' : 'service'} circular dependency: ${cycle.join(' -> ')}`,
      { cycle },
    )
    this.name = 'CircularDependencyError'
    this.cycle = cycle
  }
}

/** No provider registered for a service. */
export class NoProviderError extends KernelError {
  constructor(tokenId: string) {
    super('E_NO_PROVIDER', `no service provider: ${tokenId}`, { tokenId })
    this.name = 'NoProviderError'
  }
}

/** Capability denied (security audit). */
export class CapabilityDeniedError extends KernelError {
  readonly capability: string
  readonly pluginId: string

  constructor(capability: string, pluginId: string) {
    super(
      'E_CAPABILITY_DENIED',
      `plugin ${pluginId} is not granted the capability: ${capability}`,
      { capability, pluginId },
    )
    this.name = 'CapabilityDeniedError'
    this.capability = capability
    this.pluginId = pluginId
  }
}

/** Out-of-scope access (a plugin child container attempting to reach the parent container). */
export class ScopedAccessError extends KernelError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super('E_SCOPED_ACCESS', message, detail)
    this.name = 'ScopedAccessError'
  }
}

/** Illegal lifecycle transition. */
export class IllegalTransitionError extends KernelError {
  constructor(from: string, to: string) {
    super(
      'E_ILLEGAL_TRANSITION',
      `illegal lifecycle transition: ${from} -> ${to}`,
      {
        from,
        to,
      },
    )
    this.name = 'IllegalTransitionError'
  }
}

/** Manifest validation failed. */
export class ManifestError extends KernelError {
  readonly issues: string[]

  constructor(issues: string[], filePath?: string) {
    super(
      'E_INVALID_MANIFEST',
      `invalid plugin manifest${filePath ? ` (${filePath})` : ''}: ${issues.join('; ')}`,
      { issues, filePath },
    )
    this.name = 'ManifestError'
    this.issues = issues
  }
}

/** Drift between a plugin instance's inline manifest and plugin.json (id mismatch). */
export class ManifestMismatchError extends KernelError {
  constructor(pluginId: string, instanceId: string) {
    super(
      'E_MANIFEST_MISMATCH',
      `plugin instance manifest drift: plugin.json id=${pluginId}, instance manifest.id=${instanceId}`,
      { pluginId, instanceId },
    )
    this.name = 'ManifestMismatchError'
  }
}

/** Plugin entry escapes the plugin root directory (security boundary). */
export class EntryEscapeError extends KernelError {
  constructor(pluginId: string, entry: string) {
    super(
      'E_ENTRY_ESCAPE',
      `plugin entry escaped the root directory: ${pluginId} entry=${entry}`,
      {
        pluginId,
        entry,
      },
    )
    this.name = 'EntryEscapeError'
  }
}

/** No responder for an RPC topic. */
export class NoResponderError extends KernelError {
  constructor(topic: string) {
    super('E_NO_RESPONDER', `no responder for topic: ${topic}`, { topic })
    this.name = 'NoResponderError'
  }
}

/** Provider is not writable. */
export class NotWritableError extends KernelError {
  constructor(name: string) {
    super('E_NOT_WRITABLE', `config provider not writable: ${name}`, { name })
    this.name = 'NotWritableError'
  }
}

/** Contribution to an undeclared extension point (rejected outright, never silent). */
export class UnknownExtensionPointError extends KernelError {
  readonly point: string

  constructor(point: string) {
    super(
      'E_UNKNOWN_EXTENSION_POINT',
      `undeclared extension point: ${point} (extension points must be explicitly defined in extensions/definitions.ts)`,
      { point },
    )
    this.name = 'UnknownExtensionPointError'
    this.point = point
  }
}

/** Extension-point slot conflict (singleton slot rejects new / same id in a multi-contribution slot). */
export class ExtensionConflictError extends KernelError {
  readonly point: string
  readonly contributionId: string
  readonly holderPluginId: string | undefined

  constructor(
    point: string,
    contributionId: string,
    holderPluginId: string | undefined,
  ) {
    super(
      'E_EXTENSION_CONFLICT',
      `extension point conflict: slot "${contributionId}" of ${point} is already occupied by ${
        holderPluginId
          ? `plugin ${holderPluginId}`
          : 'the host default implementation'
      }`,
      { point, contributionId, holderPluginId },
    )
    this.name = 'ExtensionConflictError'
    this.point = point
    this.contributionId = contributionId
    this.holderPluginId = holderPluginId
  }
}
