/**
 * 插件注册表：内核与插件只读视图的统一数据源。
 *
 * 状态类型改用 `PluginStateT`（单一来源，见 `contracts/plugins.ts`）；
 * 条目形状 `LoadedPlugin` 定义在 `extensions/ports-types.ts`，以便 `loader.replace`
 * 端口与本注册表共用同一份结构。
 */

import type {
  LoadedPlugin,
  PluginHealth,
} from '../extensions/ports-types.js';
import type {
  PluginInfo,
  PluginsRegistryView,
  PluginStateT,
} from '../contracts/plugins.js';

export class PluginsRegistry implements PluginsRegistryView {
  private readonly plugins = new Map<string, LoadedPlugin>();

  /** 添加/覆盖插件条目。 */
  add(plugin: LoadedPlugin): void {
    this.plugins.set(plugin.manifest.id, plugin);
  }

  getLoaded(pluginId: string): LoadedPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  /** 全部插件条目（按 id 排序，确定性）。 */
  allLoaded(): LoadedPlugin[] {
    return Array.from(this.plugins.values()).sort((a, b) =>
      a.manifest.id.localeCompare(b.manifest.id, 'en'),
    );
  }

  /** 按状态过滤（内核用）。 */
  byStateLoaded(state: PluginStateT): LoadedPlugin[] {
    return this.allLoaded().filter((p) => p.state === state);
  }

  setState(pluginId: string, state: PluginStateT): void {
    const p = this.plugins.get(pluginId);
    if (p) p.state = state;
  }

  setHealth(pluginId: string, health: PluginHealth): void {
    const p = this.plugins.get(pluginId);
    if (p) p.health = health;
  }

  remove(pluginId: string): void {
    this.plugins.delete(pluginId);
  }

  get size(): number {
    return this.plugins.size;
  }

  // ── PluginsRegistryView 实现（插件可见的只读视图） ──

  has(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  isStarted(pluginId: string): boolean {
    return this.plugins.get(pluginId)?.state === 'Active';
  }

  get(pluginId: string): PluginInfo | undefined {
    const p = this.plugins.get(pluginId);
    return p ? toInfo(p) : undefined;
  }

  all(): PluginInfo[] {
    return this.allLoaded().map(toInfo);
  }

  byState(state: PluginStateT): PluginInfo[] {
    return this.allLoaded()
      .filter((p) => p.state === state)
      .map(toInfo);
  }
}

function toInfo(p: LoadedPlugin): PluginInfo {
  return {
    id: p.manifest.id,
    name: p.manifest.name,
    version: p.manifest.version,
    state: p.state,
    manifest: p.manifest,
  };
}
