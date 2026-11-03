/**
 * IPC contract - the single source of truth for strings shared by host and frontend.
 *
 * Why it lives in `src/shared/` instead of `src/host/ipc/`: the renderer must not
 * import host source code. The frontend therefore used to hand-copy a whitelist
 * mirror (`frontend/lib/channels.ts`), leaving 3 copies of the same method and
 * event names in the repo - adding one IPC method meant editing 4 files, and a
 * missed copy left the renderer permanently deaf to that method.
 *
 * `src/shared/` is a neutral layer: host and frontend both depend on it and never
 * on each other. That makes "one object = one string" hold:
 * - `channels` / `events` are organized as "semantic name -> external true name";
 * - semantic name and true name sit in the same object, so "added the true name
 *   but forgot the semantic name" cannot happen (the root cause of missed copies
 *   is gone);
 * - frontend and host import the same object, so "each copies its own variant"
 *   cannot happen (the root cause of drift is gone);
 * - host-side implementation tables reference the true names here with computed
 *   keys (`[channels.panelList]: handler`), so method and event names appear
 *   exactly once in the whole repo.
 *
 * This file must stay import-free (pure literals + pure types): it is referenced
 * by preload, the Electron main process, the renderer and vitest, and any
 * dependency would let the renderer indirectly reach Node / Electron code.
 * The contract test `tests/contract/ipc-contract.test.ts` asserts this.
 */

export const Ipc = {
  /** renderer -> main: request (carries an id; the main process replies by id). */
  Invoke: 'rem2:invoke',
  /** main -> renderer: event push (no id). */
  Event: 'rem2:event',
} as const

export type IpcChannel = (typeof Ipc)[keyof typeof Ipc]

/**
 * Method whitelist: semantic name -> external method name.
 *
 * This is the sole upper bound of what the renderer may do. Prefix matching
 * would hand over the entire `command:` namespace, so methods are listed one by one.
 */
export const channels = {
  /** Fetch the plugin panel list. */
  panelList: 'ui.panel.list',
  /** Fetch the render data of one panel. */
  panelData: 'ui.panel.data',
  /** Fetch the navigation entries. */
  routeList: 'ui.route.list',
  /** Fetch the theme catalog and the active theme id. */
  themeList: 'ui.theme.list',
  /** Switch the active theme. */
  themeSet: 'ui.theme.set',
  /**
   * Report the title bar's resolved colors. The window-controls overlay is
   * painted by the OS, so only the renderer knows the colors the bar actually
   * renders with; the host applies them to the native buttons.
   */
  titleBarColors: 'ui.titlebar.colors',
  /** Report a UI interaction. */
  uiEvent: 'ui.event',
  pluginList: 'plugin.list',
  pluginDetail: 'plugin.detail',
  /**
   * Install from a directory picked in the main process. The source is part of
   * the method name so a future remote install gets its own explicit method
   * (`plugin.install.remote`) instead of overloading one `install`.
   */
  pluginInstallFromDirectory: 'plugin.install.directory',
  pluginEnable: 'plugin.enable',
  /**
   * Grant declared capabilities to a user-installed plugin. Sandboxed plugins
   * are denied sensitive capabilities by default; the grant is persisted and
   * applies on the next start.
   */
  pluginPermissionGrant: 'plugin.permission.grant',
  pluginDisable: 'plugin.disable',
  pluginUninstall: 'plugin.uninstall',
  /** Restart every plugin in place; the kernel, host process and window stay alive. */
  pluginRestart: 'plugin.restart',
  /**
   * Remote install is split into inspect (download + verify + read manifest,
   * nothing installed) and install (explicit user confirmation). `operationId`
   * is renderer-generated so progress events and cancellation can be correlated
   * before the operation finishes.
   */
  pluginRemoteInspect: 'plugin.remote.inspect',
  pluginInstallFromRemote: 'plugin.install.remote',
  /** Install a previously uninstalled plugin again from its recorded source. */
  pluginReinstall: 'plugin.reinstall',
  pluginDownloadCancel: 'plugin.download.cancel',
  pluginUpdateCheck: 'plugin.update.check',
  pluginUpdateInstall: 'plugin.update.install',
  /** Read the host-owned proxy settings and the proxy Chromium actually resolves. */
  settingsProxyGet: 'settings.proxy.get',
  /** Replace proxy settings; applied to the default session immediately. */
  settingsProxySet: 'settings.proxy.set',
  /** Read the persisted appearance settings (the renderer color mode). */
  settingsAppearanceGet: 'settings.appearance.get',
  /** Persist the renderer color mode; the renderer applies it on the next start. */
  settingsAppearanceSet: 'settings.appearance.set',
  /** Execute a command (responded directly by a command plugin; the host does not implement it). */
  commandExecute: 'command.execute',
  /** Fetch the health report. */
  healthReport: 'health.report',
} as const

/**
 * Event whitelist: semantic name -> external event name.
 *
 * Only events allowed to be pushed to the renderer are listed; the kernel's
 * remaining topics (e.g. `config.changed`) carry internal state and never leak.
 */
export const events = {
  /** Theme switched. */
  themeChanged: 'ui.theme.changed',
  /** Plugin start/stop state changed. */
  pluginStateChanged: 'plugin.state-changed',
  /** Panel data refreshed. */
  panelDataChanged: 'panel.data-changed',
  /** Command execution result. */
  commandResult: 'command.result',
  /** Kernel ready. */
  kernelReady: 'kernel.ready',
  /** Remote package download/verification progress (host-originated). */
  pluginDownloadProgress: 'plugin.download.progress',
} as const

/** Method names the renderer may call (union type). */
export type AllowedMethod = (typeof channels)[keyof typeof channels]

/** Event names allowed to be pushed to the renderer (union type). */
export type AllowedEvent = (typeof events)[keyof typeof events]

/** Method whitelist (exhaustive, derived from `channels`; do not hand-write a second copy). */
export const ALLOWED_METHODS: readonly AllowedMethod[] = Object.values(channels)

/** Event whitelist (exhaustive, derived from `events`; do not hand-write a second copy). */
export const ALLOWED_EVENTS: readonly AllowedEvent[] = Object.values(events)

/** Method whitelist set (the criterion used by `IpcBridge`). */
export const ALLOWED_METHOD_SET: ReadonlySet<string> = new Set(ALLOWED_METHODS)

/** Event whitelist set. */
export const ALLOWED_EVENT_SET: ReadonlySet<string> = new Set(ALLOWED_EVENTS)

export type PluginSourceDto = 'builtin' | 'user' | 'workspace'

/** Host-wide network proxy mode (defaults to the OS settings). */
export type ProxyModeDto = 'system' | 'direct' | 'manual'

export interface ProxySettingsDto {
  mode: ProxyModeDto
  /** Manual mode only: normalized `http://host:port` or `https://host:port`. */
  address?: string
  /** Manual mode only: comma-separated Chromium bypass rules. */
  bypass?: string
  /**
   * Runtime diagnostic from `session.resolveProxy`, e.g. `PROXY 127.0.0.1:7890`.
   * Never persisted and may be absent on platforms that cannot resolve it.
   */
  resolved?: string
}

/** Renderer color mode (also the theme catalog's `ThemeMode`). */
export type ColorModeDto = 'light' | 'dark' | 'system'

/** Host-persisted appearance settings (renderer UI preferences, not kernel state). */
export interface AppearanceSettingsDto {
  colorMode: ColorModeDto
}

export type PluginRuntimeStateDto =
  | 'Registered'
  | 'Resolved'
  | 'Dropped'
  | 'Loaded'
  | 'Initialized'
  | 'Configured'
  | 'Active'
  | 'Degraded'
  | 'Failed'
  | 'Stopped'
  | 'Unloaded'
  | 'Disposed'
  | 'Disabled'
  /** Uninstalled but still listed; it can be installed again from its source. */
  | 'NotInstalled'

export interface PluginSummaryDto {
  id: string
  name: string
  version: string
  description?: string
  source: PluginSourceDto
  state: PluginRuntimeStateDto
  enabled: boolean
  builtin: boolean
  error?: string
}

export interface PluginDetailDto extends PluginSummaryDto {
  entry: string
  author?: string
  homepage?: string
  tags: string[]
  dependencies: Record<string, string>
  optionalDependencies: Record<string, string>
  requires: string[]
  /** Effective capability decision: denied entries need an explicit grant. */
  permissions: PluginPermissionDto
  compatibility: {
    minKernel: string
    maxKernel?: string
    contractVersion: string
  }
  canUninstall: boolean
  /** Uninstalled but records remain, so the Install action can restore it. */
  canInstall: boolean
  /** Disabled on disk but still loaded in the running plugin service. */
  restartRequired: boolean
  /** Where this plugin came from; remote installs keep their release URL and digest. */
  origin?: PluginOriginDto
}

export interface PluginPermissionDto {
  granted: string[]
  denied: string[]
}

export interface PluginOriginDto {
  kind: 'directory' | 'remote'
  url?: string
  sha256?: string
  publishedAt?: string
}

/** Read-only view of a remote release, produced before anything is installed. */
export interface PluginRemoteInspectionDto {
  url: string
  downloadUrl: string
  id: string
  name: string
  version: string
  description?: string
  requires: string[]
  dependencies: Record<string, string>
  optionalDependencies: Record<string, string>
  compatibility: {
    minKernel: string
    maxKernel?: string
    contractVersion: string
  }
  publishedAt?: string
  notes?: string
  /** Digest from trusted release metadata; never derived from the download itself. */
  sha256?: string
  /** Bytes of the downloaded archive, when known. */
  size?: number
}

export interface PluginUpdateDto {
  pluginId: string
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
  url: string
  publishedAt?: string
  notes?: string
  sha256?: string
}

export interface PluginUpdateCheckDto {
  updates: PluginUpdateDto[]
  /** Per-plugin source failures and updates that cannot be applied as-is. */
  issues: string[]
}

export type PluginDownloadPhase =
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'installing'

export interface PluginDownloadProgressDto {
  operationId: string
  phase: PluginDownloadPhase
  receivedBytes?: number
  totalBytes?: number
}

export interface PluginListDto {
  plugins: PluginDetailDto[]
  issues: string[]
  /** Any plugin whose disabled intent is not yet reflected in the running service. */
  restartRequired: boolean
}

export interface PluginOperationResultDto {
  ok: true
  changed: boolean
  restartRequired: boolean
  plugin?: PluginDetailDto
  message?: string
}

/** IPC request payload. */
export interface IpcRequest {
  id: string
  /** Method name. Untrusted at runtime; the bridge judges it exactly against `ALLOWED_METHOD_SET`. */
  method: string
  args?: unknown
}

/** IPC response payload. */
export interface IpcResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: string
  errorCode?: string
}

/** Event push payload. */
export interface IpcEventPayload {
  event: string
  payload: unknown
}
