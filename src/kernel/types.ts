/**
 * 内核内部共享类型（非契约类型）。
 *
 * 契约类型位于 `src/kernel/contracts/*`；此文件只放内核编排层自用的枚举与结构，
 * 避免污染公共契约，也避免 contracts 反向依赖实现层。
 */

import type { Plugin } from './contracts/lifecycle.js';
import type { PluginContext } from './contracts/context.js';
import type { PluginManifest } from './contracts/manifest.js';
import type { HealthStatus } from './contracts/health.js';
import type { PermissionSet } from './contracts/permission.js';
import type { Container } from './contracts/di-container.js';

/** 插件运行时状态（见 docs/02 §E.5 状态机）。 */
export enum PluginState {
  Discovered = 'Discovered',
  Loaded = 'Loaded',
  Configured = 'Configured',
  Started = 'Started',
  Degraded = 'Degraded',
  Failed = 'Failed',
  Stopped = 'Stopped',
  Unloaded = 'Unloaded',
  Disposed = 'Disposed',
}

/** 插件的健康聚合信息。 */
export interface PluginHealth {
  status: HealthStatus;
  message?: string;
  checkedAt?: number;
}

/** 已加载插件在注册表中的条目。 */
export interface LoadedPlugin {
  manifest: PluginManifest;
  instance: Plugin;
  context: PluginContext;
  container: Container;
  state: PluginState;
  health: PluginHealth;
  rootDir: string;
  /** 该插件被授予的权限集（CapabilityGuard 依赖它做拒绝判断）。 */
  permissions: PermissionSet;
}

/** 生命周期各阶段耗时记录。 */
export interface PhaseTiming {
  pluginId: string;
  phase: string;
  durationMs: number;
  ok: boolean;
}

/** 内核启动结果（供 CLI / 测试断言）。 */
export interface KernelStartResult {
  loadOrder: string[];
  started: string[];
  degraded: string[];
  failed: string[];
}

/**
 * LoadedPlugin 构造器（避免在 loader 中散落实例化细节）。
 */
export class LoadedPluginBuilder {
  private _manifest!: PluginManifest;
  private _instance!: Plugin;
  private _context!: PluginContext;
  private _container!: Container;
  private _state: PluginState = PluginState.Discovered;
  private _health: PluginHealth = { status: 'healthy' };
  private _rootDir = '';
  private _permissions!: PermissionSet;

  withManifest(manifest: PluginManifest): this {
    this._manifest = manifest;
    return this;
  }

  withInstance(instance: Plugin): this {
    this._instance = instance;
    return this;
  }

  withContext(context: PluginContext): this {
    this._context = context;
    return this;
  }

  withContainer(container: Container): this {
    this._container = container;
    return this;
  }

  withState(state: PluginState): this {
    this._state = state;
    return this;
  }

  withHealth(health: PluginHealth): this {
    this._health = health;
    return this;
  }

  withRootDir(rootDir: string): this {
    this._rootDir = rootDir;
    return this;
  }

  withPermissions(permissions: PermissionSet): this {
    this._permissions = permissions;
    return this;
  }

  build(): LoadedPlugin {
    return {
      manifest: this._manifest,
      instance: this._instance,
      context: this._context,
      container: this._container,
      state: this._state,
      health: this._health,
      rootDir: this._rootDir,
      permissions: this._permissions,
    };
  }
}
