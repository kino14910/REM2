import type { LogLevel } from '../contracts/logging.js'
import type { TrustLevel } from '../contracts/permission.js'

/** Kernel options. */
export interface KernelOptions {
  id: string
  /** User plugin root directories. */
  roots: string[]
  /** Built-in plugin root directory (source=builtin implies trusted). */
  builtinRoot?: string
  workspaceRoot?: string
  /** Config file path (passed through to the config provider; the kernel itself does not parse it). */
  configPath?: string
  /** Global trust-level override (defaults to source-based detection). */
  trustLevel?: TrustLevel
  /** Start timeout (single plugin Start phase). */
  startTimeoutMs: number
  /** Stop timeout (single plugin Stop/Unload/Dispose phases). */
  stopTimeoutMs: number
  /** Enable legacy manifest.json compatibility. */
  legacyFallback: boolean
  /** Initial log level. */
  logLevel: LogLevel
  /** Dependency resolution error handling strategy. */
  onResolveError: 'strict' | 'graceful'
  /** Initial config (injected into the kernel default memory provider). */
  initialConfig?: Record<string, unknown>
}

/** Default kernel options. */
export function defaultKernelOptions(
  partial: Partial<KernelOptions> = {},
): KernelOptions {
  return {
    id: partial.id ?? 'rem2-kernel',
    roots: partial.roots ?? [],
    ...(partial.builtinRoot !== undefined
      ? { builtinRoot: partial.builtinRoot }
      : {}),
    ...(partial.workspaceRoot !== undefined
      ? { workspaceRoot: partial.workspaceRoot }
      : {}),
    ...(partial.configPath !== undefined
      ? { configPath: partial.configPath }
      : {}),
    ...(partial.trustLevel !== undefined
      ? { trustLevel: partial.trustLevel }
      : {}),
    startTimeoutMs: partial.startTimeoutMs ?? 5000,
    stopTimeoutMs: partial.stopTimeoutMs ?? 5000,
    legacyFallback: partial.legacyFallback ?? false,
    logLevel: partial.logLevel ?? 'info',
    onResolveError: partial.onResolveError ?? 'graceful',
    ...(partial.initialConfig !== undefined
      ? { initialConfig: partial.initialConfig }
      : {}),
  }
}
