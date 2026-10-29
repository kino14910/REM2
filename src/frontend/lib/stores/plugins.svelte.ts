import { ipc } from '../ipc-client'
import { channels, events } from '../../../shared/ipc-contract'
import type {
  AllowedMethod,
  PluginDetailDto,
  PluginDownloadProgressDto,
  PluginListDto,
  PluginOperationResultDto,
  PluginRemoteInspectionDto,
  PluginUpdateDto,
} from '../../../shared/ipc-contract'
import {
  parseDownloadProgress,
  parsePluginInspection,
  parsePluginList,
  parsePluginOperation,
  parsePluginUpdateCheck,
} from '../dto-guards'

type PluginAction =
  | 'installFromDirectory'
  | 'restart'
  | 'enable'
  | 'disable'
  | 'uninstall'

export type RemotePending =
  | 'inspecting'
  | 'installing'
  | 'checking'
  | 'updating'

/**
 * Codes the host can return through `Error.code`; the message alone is not
 * enough for the confirm flow (e.g. "no digest" must read as a blocked install).
 */
const PLUGIN_ERROR_TEXT: Record<string, string> = {
  E_DIGEST_MISSING:
    'The publisher did not provide a SHA-256 digest, so installation was blocked.',
  E_DIGEST_MISMATCH:
    'SHA-256 mismatch: the download does not match the published digest.',
  E_DIGEST_INVALID: 'The digest is not a valid SHA-256 value.',
  E_SOURCE_INVALID:
    'Unsupported source: only HTTPS release URLs on the allowlist are accepted.',
  E_DOWNLOAD: 'The package could not be downloaded.',
  E_DOWNLOAD_TIMEOUT: 'The download timed out.',
  E_CANCELLED: 'The download was cancelled.',
  E_PACKAGE_TOO_LARGE: 'The package exceeds the size limits.',
  E_PACKAGE_INVALID: 'The package is not a valid ZIP archive.',
  E_PATH_ESCAPE: 'The package contains an unsafe path.',
  E_UNSAFE_TREE:
    'The package contains links or special files that are not allowed.',
  E_DUPLICATE_ID:
    'This plugin id is already installed; use Check updates instead.',
  E_PROVENANCE_MISSING:
    'This plugin has no recorded remote source, so it cannot be updated.',
  E_DEPENDENCY: 'The plugin has an unsatisfied hard dependency.',
  E_INCOMPATIBLE: 'The plugin is not compatible with this kernel.',
  E_UPDATE_FAILED: 'The update failed; the previous version was restored.',
  E_ROLLBACK_FAILED:
    'The update failed and the rollback did not complete; inspect the plugin directory.',
  E_INSTALL_FAILED: 'The installation failed and was cleaned up.',
  E_OPERATION_IN_PROGRESS:
    'Another operation is already running for this plugin.',
  E_MANAGER_UNAVAILABLE: 'Plugin management is unavailable.',
}

/** Readable text for a failed plugin operation (`Error.code` -> message). */
export function pluginErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code !== 'string') return message
  const text = PLUGIN_ERROR_TEXT[code]
  return text ? `${text} (${code})` : `${message} (${code})`
}

/** Renderer-generated id so progress and cancellation can be correlated. */
function newOperationId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

class PluginsStore {
  items = $state<PluginDetailDto[]>([])
  selectedId = $state<string | undefined>(undefined)
  loading = $state(false)
  loadError = $state<string | undefined>(undefined)
  actionError = $state<string | undefined>(undefined)
  notice = $state<string | undefined>(undefined)
  issues = $state<string[]>([])
  restartRequired = $state(false)
  pending = $state<{ action: PluginAction; pluginId?: string } | undefined>(
    undefined,
  )
  confirmation = $state<{ pluginId: string } | undefined>(undefined)
  selected = $derived(this.items.find(item => item.id === this.selectedId))

  /** Remote install flow: inspection is the read-only preview shown before confirmation. */
  inspection = $state<PluginRemoteInspectionDto | undefined>(undefined)
  progress = $state<PluginDownloadProgressDto | undefined>(undefined)
  remoteError = $state<string | undefined>(undefined)
  remotePending = $state<RemotePending | undefined>(undefined)
  cancelling = $state(false)
  /** Latest per-plugin update check; only `hasUpdate` entries are actionable. */
  updates = $state<PluginUpdateDto[]>([])
  updateError = $state<string | undefined>(undefined)

  private generation = 0
  private activeOperationId: string | undefined

  async load(): Promise<void> {
    const generation = ++this.generation
    this.loading = true
    try {
      const result = parsePluginList(
        await ipc.request<PluginListDto>(channels.pluginList),
      )
      if (generation !== this.generation) return
      this.items = result.items
      this.issues = result.issues
      this.restartRequired = result.restartRequired
      this.loadError = undefined
      if (!result.items.some(item => item.id === this.selectedId)) {
        this.selectedId = result.items[0]?.id
      }
    } catch (error) {
      if (generation === this.generation)
        this.loadError = (error as Error).message
    } finally {
      if (generation === this.generation) this.loading = false
    }
  }

  select(pluginId: string): void {
    this.selectedId = pluginId
    this.actionError = undefined
  }

  enable(pluginId: string): Promise<void> {
    return this.run('enable', pluginId)
  }

  disable(pluginId: string): Promise<void> {
    return this.run('disable', pluginId)
  }

  requestUninstall(pluginId: string): void {
    this.confirmation = { pluginId }
  }

  cancelConfirmation(): void {
    this.confirmation = undefined
  }

  confirm(): Promise<void> {
    const confirmation = this.confirmation
    this.confirmation = undefined
    if (!confirmation) return Promise.resolve()
    return this.run('uninstall', confirmation.pluginId)
  }

  installFromDirectory(): Promise<void> {
    return this.invoke(
      'installFromDirectory',
      channels.pluginInstallFromDirectory,
    )
  }

  restart(): Promise<void> {
    return this.invoke('restart', channels.pluginRestart)
  }

  /** Download and inspect a remote package; nothing is installed by this call. */
  async inspectRemote(url: string): Promise<void> {
    if (this.remotePending) return
    this.remotePending = 'inspecting'
    this.inspection = undefined
    this.progress = undefined
    this.remoteError = undefined
    this.activeOperationId = newOperationId()
    try {
      this.inspection = parsePluginInspection(
        await ipc.request<PluginRemoteInspectionDto>(
          channels.pluginRemoteInspect,
          { url, operationId: this.activeOperationId },
        ),
      )
    } catch (error) {
      this.remoteError = pluginErrorText(error)
    } finally {
      this.remotePending = undefined
      this.progress = undefined
    }
  }

  /** Install the currently inspected package after explicit user confirmation. */
  async installRemote(): Promise<void> {
    const inspection = this.inspection
    if (!inspection || this.remotePending) return
    this.remotePending = 'installing'
    this.progress = undefined
    this.remoteError = undefined
    this.activeOperationId = newOperationId()
    try {
      const result = parsePluginOperation(
        await ipc.request<PluginOperationResultDto>(
          channels.pluginInstallFromRemote,
          {
            operationId: this.activeOperationId,
            url: inspection.url,
            ...(inspection.sha256 ? { sha256: inspection.sha256 } : {}),
          },
        ),
      )
      this.applyResult(result)
      this.inspection = undefined
      await this.load()
    } catch (error) {
      this.remoteError = pluginErrorText(error)
    } finally {
      this.remotePending = undefined
      this.progress = undefined
      this.activeOperationId = undefined
    }
  }

  /** Abort the in-flight download; the pending call rejects with `E_CANCELLED`. */
  async cancelDownload(): Promise<void> {
    const operationId = this.activeOperationId
    if (!operationId || this.cancelling) return
    this.cancelling = true
    try {
      await ipc.request(channels.pluginDownloadCancel, { operationId })
    } catch (error) {
      this.remoteError = pluginErrorText(error)
    } finally {
      this.cancelling = false
    }
  }

  dismissRemote(): void {
    if (this.remotePending) return
    this.inspection = undefined
    this.progress = undefined
    this.remoteError = undefined
  }

  async checkUpdates(): Promise<void> {
    if (this.remotePending) return
    this.remotePending = 'checking'
    this.updateError = undefined
    try {
      const parsed = parsePluginUpdateCheck(
        await ipc.request(channels.pluginUpdateCheck, {}),
      )
      this.updates = parsed.items
      if (parsed.issues.length > 0) this.updateError = parsed.issues[0]
    } catch (error) {
      this.updateError = pluginErrorText(error)
      this.updates = []
    } finally {
      this.remotePending = undefined
    }
  }

  /** Apply an update for one plugin; the caller must have confirmed first. */
  async applyUpdate(pluginId: string): Promise<void> {
    if (this.remotePending) return
    this.remotePending = 'updating'
    this.updateError = undefined
    this.remoteError = undefined
    this.progress = undefined
    this.activeOperationId = newOperationId()
    try {
      const result = parsePluginOperation(
        await ipc.request<PluginOperationResultDto>(
          channels.pluginUpdateInstall,
          { operationId: this.activeOperationId, pluginId },
        ),
      )
      this.applyResult(result)
      this.updates = this.updates.filter(update => update.pluginId !== pluginId)
      await this.load()
    } catch (error) {
      this.updateError = pluginErrorText(error)
    } finally {
      this.remotePending = undefined
      this.progress = undefined
      this.activeOperationId = undefined
    }
  }

  /** Progress events are filtered by the active operation id (stale ones are dropped). */
  subscribeProgress(): () => void {
    return ipc.subscribe(events.pluginDownloadProgress, payload => {
      const parsed = parseDownloadProgress(payload)
      if (!parsed) return
      if (parsed.operationId !== this.activeOperationId) return
      this.progress = parsed
    })
  }

  private run(
    action: 'enable' | 'disable' | 'uninstall',
    pluginId: string,
  ): Promise<void> {
    const method =
      action === 'enable'
        ? channels.pluginEnable
        : action === 'disable'
          ? channels.pluginDisable
          : channels.pluginUninstall
    return this.invoke(action, method, { pluginId }, pluginId)
  }

  private async invoke(
    action: PluginAction,
    method: AllowedMethod,
    args?: unknown,
    pluginId?: string,
  ): Promise<void> {
    if (this.pending) return
    this.pending = { action, ...(pluginId ? { pluginId } : {}) }
    this.actionError = undefined
    this.notice = undefined
    try {
      const result = parsePluginOperation(
        await ipc.request<PluginOperationResultDto>(method, args),
      )
      this.applyResult(result)
      await this.load()
    } catch (error) {
      this.actionError = (error as Error).message
      await this.load()
    } finally {
      this.pending = undefined
    }
  }

  private applyResult(result: PluginOperationResultDto): void {
    this.restartRequired = result.restartRequired
    this.notice = result.message
    if (result.plugin) this.selectedId = result.plugin.id
  }
}

export const plugins = new PluginsStore()
