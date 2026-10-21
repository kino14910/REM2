import type { LoadedPlugin, PluginHealth } from '../extensions/ports-types.js'
import type {
  PluginInfo,
  PluginsRegistryView,
  PluginStateT,
} from '../contracts/plugins.js'

export class PluginsRegistry implements PluginsRegistryView {
  private readonly plugins = new Map<string, LoadedPlugin>()

  /** Adds or overwrites a plugin entry. */
  add(plugin: LoadedPlugin): void {
    this.plugins.set(plugin.manifest.id, plugin)
  }

  getLoaded(pluginId: string): LoadedPlugin | undefined {
    return this.plugins.get(pluginId)
  }

  /** All plugin entries (sorted by id for determinism). */
  allLoaded(): LoadedPlugin[] {
    return Array.from(this.plugins.values()).sort((a, b) =>
      a.manifest.id.localeCompare(b.manifest.id, 'en'),
    )
  }

  /** Filters entries by state (kernel-side). */
  byStateLoaded(state: PluginStateT): LoadedPlugin[] {
    return this.allLoaded().filter(p => p.state === state)
  }

  setState(pluginId: string, state: PluginStateT): void {
    const p = this.plugins.get(pluginId)
    if (p) p.state = state
  }

  setHealth(pluginId: string, health: PluginHealth): void {
    const p = this.plugins.get(pluginId)
    if (p) p.health = health
  }

  remove(pluginId: string): void {
    this.plugins.delete(pluginId)
  }

  get size(): number {
    return this.plugins.size
  }

  // ── PluginsRegistryView implementation (read-only view exposed to plugins) ──

  has(pluginId: string): boolean {
    return this.plugins.has(pluginId)
  }

  isStarted(pluginId: string): boolean {
    return this.plugins.get(pluginId)?.state === 'Active'
  }

  get(pluginId: string): PluginInfo | undefined {
    const p = this.plugins.get(pluginId)
    return p ? toInfo(p) : undefined
  }

  all(): PluginInfo[] {
    return this.allLoaded().map(toInfo)
  }

  byState(state: PluginStateT): PluginInfo[] {
    return this.allLoaded()
      .filter(p => p.state === state)
      .map(toInfo)
  }
}

function toInfo(p: LoadedPlugin): PluginInfo {
  return {
    id: p.manifest.id,
    name: p.manifest.name,
    version: p.manifest.version,
    state: p.state,
    manifest: p.manifest,
  }
}
