/**
 * In-memory config source (the kernel's default provider; the kernel deliberately
 * ships only this minimal source).
 *
 * The kernel has no built-in file config source: the JSON config source is a plugin
 * (plugins/config-json).
 */

import type { ConfigProvider } from '../contracts/config.js'
import { NotWritableError } from '../errors.js'

/** In-memory config provider (writable). */
export class MemoryConfigProvider implements ConfigProvider {
  readonly name: string
  readonly priority: number
  private data: Record<string, unknown>

  constructor(
    initial: Record<string, unknown> = {},
    name = 'memory',
    priority = 1000,
  ) {
    this.name = name
    this.priority = priority
    this.data = { ...initial }
  }

  async load(): Promise<Record<string, unknown>> {
    return { ...this.data }
  }

  async reload(): Promise<Record<string, unknown>> {
    return { ...this.data }
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data[key] = value
  }

  /** For kernel/test use: replaces everything at once. */
  replaceAll(data: Record<string, unknown>): void {
    this.data = { ...data }
  }
}

/** Read-only in-memory provider (for kernel bootstrap defaults; writes are rejected). */
export class ReadOnlyMemoryConfigProvider implements ConfigProvider {
  readonly name: string
  readonly priority: number
  constructor(
    private readonly data: Record<string, unknown>,
    name = 'kernel-defaults',
    priority = -1000,
  ) {
    this.name = name
    this.priority = priority
  }

  async load(): Promise<Record<string, unknown>> {
    return { ...this.data }
  }

  async set(_key: string, _value: unknown): Promise<void> {
    throw new NotWritableError(this.name)
  }
}
