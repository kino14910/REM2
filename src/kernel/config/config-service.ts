/**
 * Config service.
 *
 * The kernel ships no built-in config sources; it only maintains provider
 * layering, merging and change notification.
 * Layers merge bottom-up in ascending priority (higher priority wins).
 */

import type {
  ConfigAccess,
  ConfigChangeHandler,
  ConfigProvider,
  ConfigLayer,
} from '../contracts/config.js'
import type { Unsubscribe } from '../contracts/event-bus.js'
import { deepMerge, getPath } from '../util/deep-merge.js'
import { NotWritableError } from '../errors.js'

/** Record of a config provider load failure (motivation: never degrade silently). */
export interface ConfigProviderFailure {
  provider: string
  error: string
  at: number
}

export interface ConfigServiceOptions {
  /** Observability hook invoked when a provider fails to load. */
  onProviderError?: (failure: ConfigProviderFailure) => void
}

export class ConfigService implements ConfigAccess {
  private providers: ConfigProvider[] = []
  /** Merged snapshot (recomputed lazily while dirty). */
  private snapshot: Record<string, unknown> = {}
  private dirty = true
  private refreshScheduled = false
  private readonly changeHandlers = new Set<ConfigChangeHandler>()
  private readonly providerUnsubs = new Map<string, Unsubscribe>()
  /**
   * Provider load failure records.
   *
   * A single failing provider must not block the other layers, but the
   * failure must stay observable: swallowing it silently would make
   * "why is this config value the default?" impossible to diagnose.
   */
  private readonly failures: ConfigProviderFailure[] = []
  private readonly onProviderError:
    | ((failure: ConfigProviderFailure) => void)
    | null

  constructor(opts: ConfigServiceOptions = {}) {
    this.onProviderError = opts.onProviderError ?? null
  }

  /** Accumulated provider load failures (for health checks and test assertions). */
  get loadFailures(): ReadonlyArray<ConfigProviderFailure> {
    return this.failures
  }

  /** Register a provider; among equal priorities the later registration wins. */
  registerProvider(provider: ConfigProvider): void {
    // Idempotent: registering the same name replaces the previous provider.
    this.providers = this.providers.filter(p => p.name !== provider.name)
    this.providers.push(provider)
    this.providers.sort((a, b) => a.priority - b.priority)
    this.dirty = true

    if (provider.onDidChange) {
      const unsub = provider.onDidChange(keys => {
        this.dirty = true
        this.emitChange(keys, keys[0] ?? '')
      })
      this.providerUnsubs.set(provider.name, unsub)
    }
  }

  unregisterProvider(name: string): void {
    this.providers = this.providers.filter(p => p.name !== name)
    const unsub = this.providerUnsubs.get(name)
    if (unsub) {
      unsub()
      this.providerUnsubs.delete(name)
    }
    this.dirty = true
  }

  /** Layer names, ordered bottom-up (ascending priority). */
  layers(): string[] {
    return this.providers.map(p => p.name)
  }

  layerDetails(): ConfigLayer[] {
    return this.providers.map(p => ({ name: p.name, priority: p.priority }))
  }

  async refresh(): Promise<void> {
    const loaded: Array<Record<string, unknown>> = []
    for (const p of this.providers) {
      try {
        loaded.push(await p.load())
      } catch (error) {
        // A single provider failure must not block other layers, but it must be recorded and reported (never degrade silently).
        const failure: ConfigProviderFailure = {
          provider: p.name,
          error: (error as Error).message,
          at: Date.now(),
        }
        this.failures.push(failure)
        this.onProviderError?.(failure)
      }
    }
    let acc: Record<string, unknown> = {}
    for (const layer of loaded) {
      acc = deepMerge(acc, layer)
    }
    this.snapshot = acc
    this.dirty = false
  }

  /** Clear the recorded failures (for tests and operations). */
  clearLoadFailures(): void {
    this.failures.length = 0
  }

  /**
   * Read a config value (supports 'a.b.c' paths).
   *
   * While dirty, refresh is lazy: a synchronous read returns the previous
   * snapshot without blocking and schedules the refresh as a microtask.
   * Without this, writes performed by provider.load() before an explicit
   * refresh() would never become visible.
   */
  get<T>(key: string, defaultValue?: T): T {
    this.ensureFresh()
    const value = getPath(this.snapshot, key)
    if (value === undefined) return defaultValue as T
    return value as T
  }

  getOrThrow<T>(key: string): T {
    this.ensureFresh()
    const value = getPath(this.snapshot, key)
    if (value === undefined) {
      throw new Error(`missing config key: ${key}`)
    }
    return value as T
  }

  has(key: string): boolean {
    this.ensureFresh()
    return getPath(this.snapshot, key) !== undefined
  }

  /**
   * Write through the highest-priority writable provider, then incrementally
   * merge the affected layer into the snapshot.
   *
   * Only the written layer is reloaded and deep-merged; a full refresh()
   * would re-run every provider's load(), with cost growing linearly in
   * the number of providers.
   */
  async set(key: string, value: unknown): Promise<void> {
    const writable = [...this.providers]
      .reverse()
      .find(p => typeof p.set === 'function')
    if (!writable || !writable.set) {
      throw new NotWritableError('(none)')
    }
    await writable.set(key, value)

    let layer: Record<string, unknown> = {}
    try {
      layer = await writable.load()
    } catch (error) {
      const failure: ConfigProviderFailure = {
        provider: writable.name,
        error: (error as Error).message,
        at: Date.now(),
      }
      this.failures.push(failure)
      this.onProviderError?.(failure)
    }
    this.snapshot = deepMerge(this.snapshot, layer)
    this.dirty = true
    // The snapshot is already up to date; avoid ensureFresh triggering another full refresh immediately.
    this.dirty = false
    this.emitChange([key], key)
  }

  onDidChange(cb: ConfigChangeHandler): Unsubscribe {
    this.changeHandlers.add(cb)
    return () => this.changeHandlers.delete(cb)
  }

  /** Current snapshot (for tests and debugging). */
  snapshotOf(): Record<string, unknown> {
    return this.snapshot
  }

  get isDirty(): boolean {
    return this.dirty
  }

  /** Schedule a full refresh while dirty; synchronous readers do not wait for it. */
  private ensureFresh(): void {
    if (!this.dirty || this.refreshScheduled) return
    this.refreshScheduled = true
    queueMicrotask(() => {
      this.refreshScheduled = false
      void this.refresh().catch(() => undefined)
    })
  }

  private emitChange(keys: string[], key: string): void {
    for (const cb of this.changeHandlers) {
      try {
        cb(keys, key)
      } catch {
        // Ignore errors thrown by individual listeners.
      }
    }
  }
}
