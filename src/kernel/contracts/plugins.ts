/**
 * 插件注册表视图契约（纯类型）。见 docs/02 §D.6（软依赖运行期探测）。
 */

import type { PluginManifest } from './manifest.js';

/** 插件状态（与内核 PluginState 对齐的字符串联合，避免契约依赖实现枚举）。 */
export type PublicPluginState =
  | 'Discovered'
  | 'Loaded'
  | 'Configured'
  | 'Started'
  | 'Degraded'
  | 'Failed'
  | 'Stopped'
  | 'Unloaded'
  | 'Disposed';

/** 插件对外可见的摘要信息。 */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  state: PublicPluginState;
  manifest: PluginManifest;
}

/**
 * 插件视图：供插件运行期探测其他插件与读取只读信息。
 */
export interface PluginsRegistryView {
  /** 是否存在某插件（软依赖探测的主要入口）。 */
  has(pluginId: string): boolean;
  /** 某插件是否已达 Started 状态。 */
  isStarted(pluginId: string): boolean;
  /** 获取某插件信息。 */
  get(pluginId: string): PluginInfo | undefined;
  /** 列出全部插件信息。 */
  all(): PluginInfo[];
  /** 按状态过滤。 */
  byState(state: PublicPluginState): PluginInfo[];
}
