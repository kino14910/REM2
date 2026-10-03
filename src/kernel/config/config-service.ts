/**
 * 配置服务（docs/02 §H，动机 #10）。
 *
 * 内核不内置任何具体配置源，只维护「provider 分层 + 合并 + 变更通知」。
 * 分层规则：priority 升序「自底向上」合并（priority 大者覆盖小者）。
 */

import type {
  ConfigAccess,
  ConfigChangeHandler,
  ConfigProvider,
  ConfigLayer,
} from '../contracts/config.js';
import type { Unsubscribe } from '../contracts/event-bus.js';
import { deepMerge, getPath } from '../util/deep-merge.js';
import { NotWritableError } from '../errors.js';

/**
 * 配置 provider 加载失败记录（动机：绝不静默降级）。
 */
export interface ConfigProviderFailure {
  provider: string;
  error: string;
  at: number;
}

/** ConfigService 选项。 */
export interface ConfigServiceOptions {
  /** provider 加载失败回调（可观测性钩子）。 */
  onProviderError?: (failure: ConfigProviderFailure) => void;
}

/**
 * 配置服务实现（同时实现 ConfigAccess 供插件消费）。
 */
export class ConfigService implements ConfigAccess {
  private providers: ConfigProvider[] = [];
  /** 合并后的快照（懒计算）。 */
  private snapshot: Record<string, unknown> = {};
  private dirty = true;
  private readonly changeHandlers = new Set<ConfigChangeHandler>();
  private readonly providerUnsubs = new Map<string, Unsubscribe>();
  /**
   * provider 加载失败记录。
   *
   * 单个 provider 失败确实不应阻断其他层，但**必须可观测**：
   * 静默吞掉会让"配置为何是默认值"无从排查（对照基线正是这类静默失败的反面教材）。
   */
  private readonly failures: ConfigProviderFailure[] = [];
  private readonly onProviderError:
    | ((failure: ConfigProviderFailure) => void)
    | null;

  constructor(opts: ConfigServiceOptions = {}) {
    this.onProviderError = opts.onProviderError ?? null;
  }

  /** 累计的 provider 加载失败（供健康检查/测试断言）。 */
  get loadFailures(): ReadonlyArray<ConfigProviderFailure> {
    return this.failures;
  }

  /** 注册 provider（同优先级按注册顺序，后者覆盖前者）。 */
  registerProvider(provider: ConfigProvider): void {
    // 幂等：同 name 替换。
    this.providers = this.providers.filter((p) => p.name !== provider.name);
    this.providers.push(provider);
    this.providers.sort((a, b) => a.priority - b.priority);
    this.dirty = true;

    if (provider.onDidChange) {
      const unsub = provider.onDidChange((keys) => {
        this.dirty = true;
        this.emitChange(keys, keys[0] ?? '');
      });
      this.providerUnsubs.set(provider.name, unsub);
    }
  }

  /** 注销 provider。 */
  unregisterProvider(name: string): void {
    this.providers = this.providers.filter((p) => p.name !== name);
    const unsub = this.providerUnsubs.get(name);
    if (unsub) {
      unsub();
      this.providerUnsubs.delete(name);
    }
    this.dirty = true;
  }

  /** 层级列表（自底向上）。 */
  layers(): string[] {
    return this.providers.map((p) => p.name);
  }

  /** 层级描述。 */
  layerDetails(): ConfigLayer[] {
    return this.providers.map((p) => ({ name: p.name, priority: p.priority }));
  }

  /** 强制重新加载所有 provider 并合并。 */
  async refresh(): Promise<void> {
    const loaded: Array<Record<string, unknown>> = [];
    for (const p of this.providers) {
      try {
        loaded.push(await p.load());
      } catch (error) {
        // 单个 provider 失败不阻断其他层，但**必须记录并上报**（绝不静默降级）。
        const failure: ConfigProviderFailure = {
          provider: p.name,
          error: (error as Error).message,
          at: Date.now(),
        };
        this.failures.push(failure);
        this.onProviderError?.(failure);
      }
    }
    let acc: Record<string, unknown> = {};
    for (const layer of loaded) {
      acc = deepMerge(acc, layer);
    }
    this.snapshot = acc;
    this.dirty = false;
  }

  /** 清空失败记录（测试/运维用）。 */
  clearLoadFailures(): void {
    this.failures.length = 0;
  }

  /** 读取配置（支持 'a.b.c' 路径）。 */
  get<T>(key: string, defaultValue?: T): T {
    const value = getPath(this.snapshot, key);
    if (value === undefined) return defaultValue as T;
    return value as T;
  }

  /** 读取必填配置，缺失抛错。 */
  getOrThrow<T>(key: string): T {
    const value = getPath(this.snapshot, key);
    if (value === undefined) {
      throw new Error(`配置项缺失：${key}`);
    }
    return value as T;
  }

  has(key: string): boolean {
    return getPath(this.snapshot, key) !== undefined;
  }

  /** 写入（写入优先级最高的可写 provider）。 */
  async set(key: string, value: unknown): Promise<void> {
    // 从高到低找可写 provider。
    const writable = [...this.providers]
      .reverse()
      .find((p) => typeof p.set === 'function');
    if (!writable || !writable.set) {
      throw new NotWritableError('(none)');
    }
    await writable.set(key, value);
    this.dirty = true;
    await this.refresh();
    this.emitChange([key], key);
  }

  /** 注册变更监听。 */
  onDidChange(cb: ConfigChangeHandler): Unsubscribe {
    this.changeHandlers.add(cb);
    return () => this.changeHandlers.delete(cb);
  }

  /** 快照（测试/调试）。 */
  snapshotOf(): Record<string, unknown> {
    return this.snapshot;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  private emitChange(keys: string[], key: string): void {
    for (const cb of this.changeHandlers) {
      try {
        cb(keys, key);
      } catch {
        // 忽略单个监听器错误。
      }
    }
  }
}
