/**
 * 内存配置源（内核默认 provider，动机 #10：内核只提供最小可用的内存源）。
 *
 * 内核不内置文件配置源 —— JSON 配置源是插件（plugins/config-json）。
 */

import type { ConfigProvider } from '../contracts/config.js';
import { NotWritableError } from '../errors.js';

/**
 * 内存配置 provider（可写）。
 */
export class MemoryConfigProvider implements ConfigProvider {
  readonly name: string;
  readonly priority: number;
  private data: Record<string, unknown>;

  constructor(
    initial: Record<string, unknown> = {},
    name = 'memory',
    priority = 1000,
  ) {
    this.name = name;
    this.priority = priority;
    this.data = { ...initial };
  }

  async load(): Promise<Record<string, unknown>> {
    return { ...this.data };
  }

  async reload(): Promise<Record<string, unknown>> {
    return { ...this.data };
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data[key] = value;
  }

  /** 内核/测试用：整体替换。 */
  replaceAll(data: Record<string, unknown>): void {
    this.data = { ...data };
  }
}

/**
 * 只读内存 provider（用于内核引导默认值，禁止写入）。
 */
export class ReadOnlyMemoryConfigProvider implements ConfigProvider {
  readonly name: string;
  readonly priority: number;
  constructor(
    private readonly data: Record<string, unknown>,
    name = 'kernel-defaults',
    priority = -1000,
  ) {
    this.name = name;
    this.priority = priority;
  }

  async load(): Promise<Record<string, unknown>> {
    return { ...this.data };
  }

  async set(_key: string, _value: unknown): Promise<void> {
    throw new NotWritableError(this.name);
  }
}
