/**
 * 配置契约（纯类型）。见 docs/01
 *
 * 核心原则（动机 #10）：内核只定义 `ConfigProvider` 契约；配置从哪来全部是插件。
 */

import type { Unsubscribe } from './event-bus.js';

/**
 * 配置源契约。
 */
export interface ConfigProvider {
  /** provider 名，如 'json' / 'env' / 'memory' / 'remote'。 */
  readonly name: string;
  /** 层级优先级，越大越"上层"（覆盖下层）。内核默认：memory=1000, env=100, json=10。 */
  readonly priority: number;
  /** 只读：加载整份配置（返回扁平化 key->value）。 */
  load(): Promise<Record<string, unknown>>;
  /** 可选：重新加载（文件监听触发）。 */
  reload?(): Promise<Record<string, unknown>>;
  /** 可选：变更通知。 */
  onDidChange?(cb: (changedKeys: string[]) => void): Unsubscribe;
  /** 可选：写入（只读 provider 可抛 NotWritableError）。 */
  set?(key: string, value: unknown): Promise<void>;
}

/** 配置层描述（供调试/展示）。 */
export interface ConfigLayer {
  name: string;
  priority: number;
}

/** 配置变更回调。 */
export type ConfigChangeHandler = (changedKeys: string[], key: string) => void;

/**
 * 插件侧只读配置访问接口（`PluginContext.config` 的类型）。
 * 实现由内核 `ConfigService` 提供。
 */
export interface ConfigAccess {
  get<T>(key: string, defaultValue?: T): T;
  getOrThrow<T>(key: string): T;
  has(key: string): boolean;
  onDidChange(cb: ConfigChangeHandler): Unsubscribe;
}
