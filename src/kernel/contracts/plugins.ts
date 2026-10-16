/**
 * 插件状态与注册表视图契约。
 *
 * 状态定义的**单一来源**（docs/03 §4.4）：删除旧的 `PluginState` 真 enum 与
 * `PublicPluginState`，二者合并为此处一份 `PLUGIN_STATES` + `PluginStateT`。
 * 理由：真 enum 是运行期对象（会给 bundle 引入运行期值），且与 `PublicPluginState` 构成双源。
 */

import type { PluginManifest } from './manifest.js';

/** 逻辑状态机的全部状态（有序；索引即状态跃迁的大致次序）。 */
export const PLUGIN_STATES = [
  'Registered',
  'Resolved',
  'Dropped',
  'Loaded',
  'Initialized',
  'Configured',
  'Active',
  'Degraded',
  'Failed',
  'Stopped',
  'Unloaded',
  'Disposed',
] as const;

/** 插件状态（单一来源的字符串联合）。 */
export type PluginStateT = (typeof PLUGIN_STATES)[number];

/** 终态：不再有任何出边。 */
export const TERMINAL_STATES: readonly PluginStateT[] = [
  'Dropped',
  'Disposed',
];

/** 插件对外可见的摘要信息。 */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  state: PluginStateT;
  manifest: PluginManifest;
}

/** 插件视图：供插件运行期探测其他插件与读取只读信息。 */
export interface PluginsRegistryView {
  /** 是否存在某插件（软依赖探测的主要入口）。 */
  has(pluginId: string): boolean;
  /** 某插件是否已达 Active 状态。 */
  isStarted(pluginId: string): boolean;
  /** 获取某插件信息。 */
  get(pluginId: string): PluginInfo | undefined;
  /** 列出全部插件信息。 */
  all(): PluginInfo[];
  /** 按状态过滤。 */
  byState(state: PluginStateT): PluginInfo[];
}
