/** Compatibility constraints. */
export interface Compatibility {
  /** Minimum kernel version (semver range), e.g. "^1.0.0". */
  minKernel: string
  /** Optional: maximum kernel version (inclusive), used to block incompatible major versions. */
  maxKernel?: string
  /** Contract version, e.g. "1"; a different major means incompatible. */
  contractVersion: string
}

/** Extension-point contribution declaration (manifest side, static). */
export interface ManifestContribution {
  /** Extension point id (must be a member of `ExtensionPointId`). */
  point: string
  /** Unique id within the slot. */
  id: string
  /** Capability required to contribute to this extension point; defaults to the capability on the extension point definition. */
  capability?: string
}

/** Plugin manifest. */
export interface PluginManifest {
  /** Unique id; reverse-DNS recommended: com.example.hello-command. */
  id: string
  /** Display name. */
  name: string
  /** Plugin's own version (semver). */
  version: string
  /**
   * Entry (relative to rootDir). Build output only: must end with `.js` / `.mjs`.
   * Validated at registration by `manifest-validator`; the loader no longer completes `.ts`.
   */
  entry: string

  /** Hard dependencies: pluginId -> semver range. Missing/unsatisfied -> that plugin fails. */
  dependencies?: Record<string, string>
  /** Soft dependencies: when missing the plugin enters degraded mode; other features still run. */
  optionalDependencies?: Record<string, string>

  /** What I provide: statically declared extension-point contributions. */
  contributes?: ManifestContribution[]

  /** What I need: capability declarations (input to `PermissionManager.check`). */
  requires?: string[]

  /** Compatibility constraints. */
  compatibility: Compatibility

  author?: string
  description?: string
  icon?: string
  tags?: string[]
  homepage?: string

  /**
   * Isolation strategy:
   * - 'in-process' (default): runs in the kernel process; highest performance, highest trust requirement.
   * - 'worker': runs in a separate Node worker thread; the kernel drives the lifecycle over RPC;
   *   crashes/hangs do not block the kernel main thread, but cross-thread communication has serialization overhead.
   */
  isolation?: 'in-process' | 'worker'

  /** Plugin-level custom config schema (not interpreted by the kernel; passed through to the plugin). */
  configSchema?: Record<string, unknown>
}

/**
 * Fields that may be omitted from the first argument of `definePlugin`.
 *
 * The authoritative source of `entry` is `plugin.json` (the kernel treats the
 * on-disk manifest as the single source of truth), so the inline manifest need
 * not repeat it; `compatibility` is likewise validated by the loader.
 */
export type PluginManifestInit = Omit<
  PluginManifest,
  'entry' | 'compatibility'
> & {
  entry?: string
  compatibility?: Compatibility
}
