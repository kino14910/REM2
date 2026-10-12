/**
 * 装载端口的入参/出参形状（`ports.ts` 的辅助类型，避免循环引用）。
 */

import type { PluginContext } from '../contracts/context.js';
import type { PluginFactoryHooks } from '../contracts/plugin.js';
import type { PluginManifest } from '../contracts/manifest.js';
import type { PluginStateT } from '../contracts/plugins.js';
import type { Container } from '../contracts/container.js';
import type { PermissionSet } from '../contracts/permission.js';
import type { HealthStatus } from '../contracts/health.js';

/** 单次加载选项。 */
export interface PluginLoaderOptions {
  /**
   * 热重载时的缓存击穿标记：非空时作为 query 追加到 import 说明符，
   * 使 Node ESM 模块缓存认为这是一个新模块。
   */
  cacheBust?: string;
}

/** 插件健康聚合信息。 */
export interface PluginHealth {
  status: HealthStatus;
  message?: string;
  checkedAt?: number;
}

/** 已加载插件条目（注册表的数据形状）。 */
export interface LoadedPlugin {
  manifest: PluginManifest;
  hooks: PluginFactoryHooks;
  context: PluginContext;
  container: Container;
  state: PluginStateT;
  health: PluginHealth;
  rootDir: string;
  /** 该插件被授予的权限集（CapabilityGuard 依赖它做拒绝判断）。 */
  permissions: PermissionSet;
}
