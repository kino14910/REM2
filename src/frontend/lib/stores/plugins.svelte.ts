import { ipc } from '../ipc-client'
import { channels } from '../../../shared/ipc-contract'
import type {
  AllowedMethod,
  PluginDetailDto,
  PluginListDto,
  PluginOperationResultDto,
} from '../../../shared/ipc-contract'
import { parsePluginList, parsePluginOperation } from '../dto-guards'

type PluginAction =
  | 'installFromDirectory'
  | 'restart'
  | 'enable'
  | 'disable'
  | 'uninstall'

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
  private generation = 0

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
