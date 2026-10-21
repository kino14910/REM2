/**
 * Worker isolation host (fault isolation, not a security sandbox - docs/01 §5).
 *
 * When a plugin manifest declares `isolation: 'worker'`, the kernel does not
 * import the plugin code directly; this host loads and drives it inside a
 * separate `worker_threads` thread:
 *
 * - Host and worker communicate via structured-clone messages (RPC).
 * - A worker crash, infinite loop, or `process.exit()` cannot take down the
 *   kernel main thread: on `exit`/`error` the kernel marks that plugin Failed
 *   and the other plugins are unaffected.
 * - Honest caveat: worker isolation is *fault* isolation, not a security
 *   sandbox - worker code still has full Node capabilities. The security
 *   boundary remains CapabilityGuard on the kernel side (the only kernel
 *   facilities a plugin can reach are log / config snapshot / events /
 *   metrics via RPC proxies).
 *
 * Cross-boundary context capabilities (intentionally narrowed):
 * - `ctx.log` / `ctx.config` (init snapshot + change push) / `ctx.events`
 *   (emit/on/request) / `ctx.metrics`: available via RPC proxy.
 * - `ctx.services` / `ctx.api` / `ctx.plugins`: cannot be proxied across
 *   threads; calling them inside a worker throws.
 * - `ctx.extensions`: only log.sink / metrics.sink / trace.exporter
 *   contributions are allowed. Collaboration between worker plugins must go
 *   through the event bus (the forced decoupling of "capability as service").
 */

import { Worker } from 'node:worker_threads'
import path from 'node:path'
import type { EventBus, Unsubscribe } from '../contracts/event-bus.js'
import type { LogService } from '../observability/log-service.js'
import type { MetricsApi } from '../contracts/metrics.js'
import type { ConfigService } from '../config/config-service.js'
import type { Candidate } from '../discovery/candidate.js'
import { resolveEntry } from '../loader/module-resolver.js'
import { KernelError, TimeoutError } from '../errors.js'
import { WORKER_BOOTSTRAP_SOURCE } from './worker-bootstrap.js'
import {
  HOST_TO_WORKER,
  WORKER_TO_HOST,
  type CtxCallMessage,
} from './worker-protocol.js'

export interface WorkerHostFacilities {
  events: EventBus
  config: ConfigService
  logService: LogService
  metrics: MetricsApi
  /**
   * Real permission snapshot (docs/01 §5).
   * The old implementation hardcoded `{granted:[],denied:[]}` in the init
   * message, so worker plugins always saw "no permissions" - an existing
   * defect, not a design choice.
   */
  permissions?: { granted: string[]; denied: string[] }
  /** Extension point contribution target (workers: three sink kinds only). */
  extensions?: {
    contribute(pluginId: string, point: string, contribution: unknown): void
  }
  /** Callback for unexpected worker exit (code = exit code; the kernel marks the plugin Failed). */
  onUnexpectedExit: (
    pluginId: string,
    code: number | null,
    error?: string,
  ) => void
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const DEFAULT_HOOK_TIMEOUT_MS = 10_000

export class WorkerPluginHost {
  private worker: Worker | null = null
  private ready: Promise<void> | null = null
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  /** Worker event subscriptions: subId -> host-side unsubscribe. */
  private readonly eventSubs = new Map<number, Unsubscribe>()
  private configUnsub: Unsubscribe | null = null
  private expectingExit = false
  private failedError: string | null = null

  constructor(
    private readonly candidate: Candidate,
    private readonly facilities: WorkerHostFacilities,
  ) {}

  get pluginId(): string {
    return this.candidate.manifest.id
  }

  /**
   * Invoke a plugin hook inside the worker (lazy start: the worker is
   * spawned on the first call).
   */
  async callHook(
    hook: string,
    args: unknown[] = [],
    timeoutMs = DEFAULT_HOOK_TIMEOUT_MS,
  ): Promise<unknown> {
    await this.ensureStarted()
    if (this.failedError) {
      throw new KernelError(
        'E_LOAD_FAILED',
        `Worker plugin already failed: ${this.pluginId} - ${this.failedError}`,
      )
    }
    return await this.rpc(hook, args, timeoutMs)
  }

  /** Terminate the worker (idempotent). */
  async terminate(): Promise<void> {
    this.expectingExit = true
    this.configUnsub?.()
    this.configUnsub = null
    for (const unsub of this.eventSubs.values()) unsub()
    this.eventSubs.clear()
    const worker = this.worker
    this.worker = null
    this.ready = null
    if (worker) {
      try {
        await worker.terminate()
      } catch {
        // A failed terminate does not affect the kernel.
      }
    }
    // Reject all pending RPCs to avoid dangling.
    for (const p of this.pending.values()) {
      p.reject(
        new KernelError('E_GENERIC', `Worker terminated: ${this.pluginId}`),
      )
    }
    this.pending.clear()
  }

  // ---------------------------- internal ----------------------------

  private async ensureStarted(): Promise<void> {
    if (this.ready) return await this.ready

    const { manifest, rootDir } = this.candidate
    const { specifier } = resolveEntry(rootDir, manifest.entry, manifest.id)

    this.ready = (async () => {
      const worker = new Worker(WORKER_BOOTSTRAP_SOURCE, {
        eval: true,
        name: `plugin:${manifest.id}`,
      })
      this.worker = worker
      this.attachWorkerListeners(worker)

      const readyPromise = this.waitForReady(worker)
      worker.postMessage({
        t: HOST_TO_WORKER.Init,
        entrySpecifier: specifier,
        manifest,
        rootDir: path.resolve(rootDir),
        configSnapshot: this.facilities.config.snapshotOf(),
        permissions: this.facilities.permissions ?? { granted: [], denied: [] },
      })
      await readyPromise

      this.configUnsub = this.facilities.config.onDidChange(() => {
        worker.postMessage({
          t: HOST_TO_WORKER.Config,
          snapshot: this.facilities.config.snapshotOf(),
        })
      })
    })()

    try {
      await this.ready
    } catch (error) {
      this.ready = null
      await this.terminate()
      throw error
    }
  }

  private waitForReady(worker: Worker): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onMessage = (msg: { t?: string; message?: string }): void => {
        if (msg.t === WORKER_TO_HOST.Ready) {
          cleanup()
          resolve()
        } else if (msg.t === WORKER_TO_HOST.InitError) {
          cleanup()
          reject(
            new KernelError(
              'E_LOAD_FAILED',
              `Worker plugin failed to initialize: ${this.pluginId} - ${msg.message ?? 'unknown'}`,
            ),
          )
        }
      }
      const onExit = (code: number): void => {
        cleanup()
        reject(
          new KernelError(
            'E_LOAD_FAILED',
            `Worker exited before initialization: ${this.pluginId} (code=${code})`,
          ),
        )
      }
      const onError = (err: Error): void => {
        cleanup()
        reject(
          new KernelError(
            'E_LOAD_FAILED',
            `Worker initialization error: ${this.pluginId} - ${err.message}`,
          ),
        )
      }
      const cleanup = (): void => {
        worker.off('message', onMessage)
        worker.off('exit', onExit)
        worker.off('error', onError)
      }
      worker.on('message', onMessage)
      worker.on('exit', onExit)
      worker.on('error', onError)
    })
  }

  private attachWorkerListeners(worker: Worker): void {
    worker.on('message', (msg: Record<string, unknown>) => {
      switch (msg.t) {
        case WORKER_TO_HOST.Result: {
          const id = msg.id as number
          const p = this.pending.get(id)
          if (!p) return
          this.pending.delete(id)
          if (msg.ok) p.resolve(msg.value)
          else
            p.reject(
              new Error(
                (msg.error as string) ?? 'Worker hook execution failed',
              ),
            )
          return
        }
        case WORKER_TO_HOST.Ctx: {
          void this.handleCtxCall(worker, msg as unknown as CtxCallMessage)
          return
        }
        case WORKER_TO_HOST.Subscribe: {
          const subId = msg.subId as number
          const pattern = msg.pattern as string
          const unsub = this.facilities.events.on(pattern, payload => {
            worker.postMessage({ t: HOST_TO_WORKER.Event, subId, payload })
          })
          this.eventSubs.set(subId, unsub)
          return
        }
        case WORKER_TO_HOST.Unsub: {
          const subId = msg.subId as number
          this.eventSubs.get(subId)?.()
          this.eventSubs.delete(subId)
          return
        }
        default:
      }
    })

    worker.on('error', err => {
      this.failedError = err.message
      this.facilities.onUnexpectedExit(this.pluginId, null, err.message)
    })

    worker.on('exit', code => {
      if (!this.expectingExit) {
        this.failedError = `Worker exited unexpectedly (code=${code})`
        this.facilities.onUnexpectedExit(this.pluginId, code)
      }
    })
  }

  private async handleCtxCall(
    worker: Worker,
    msg: CtxCallMessage,
  ): Promise<void> {
    const reply = (ok: boolean, value?: unknown, error?: string): void => {
      worker.postMessage({
        t: HOST_TO_WORKER.CtxResult,
        id: msg.id,
        ok,
        value,
        error,
      })
    }
    try {
      const [domain, ...rest] = msg.path
      const result = await this.dispatchCtx(domain ?? '', rest, msg.args)
      reply(true, result)
    } catch (error) {
      reply(false, undefined, (error as Error).message)
    }
  }

  /**
   * Context call dispatch (whitelist: only log / events / metrics /
   * config.get / extensions.contribute are proxied).
   */
  private async dispatchCtx(
    domain: string,
    rest: string[],
    args: unknown[],
  ): Promise<unknown> {
    const log = this.facilities.logService.child(
      `plugin:${this.pluginId}`,
      this.pluginId,
    )
    switch (domain) {
      case 'log': {
        const level = rest[0] as
          | 'trace'
          | 'debug'
          | 'info'
          | 'warn'
          | 'error'
          | 'fatal'
        const fn = log[level]
        if (typeof fn !== 'function')
          throw new Error(`Unknown log level: ${level}`)
        fn.call(
          log,
          String(args[0] ?? ''),
          args[1] as Record<string, unknown> | undefined,
        )
        return undefined
      }
      case 'events': {
        const op = rest[0]
        if (op === 'emit') {
          await this.facilities.events.emit(String(args[0]), args[1])
          return undefined
        }
        if (op === 'request') {
          const timeoutMs = typeof args[2] === 'number' ? args[2] : 5000
          return await this.facilities.events.request(
            String(args[0]),
            args[1],
            { timeoutMs },
          )
        }
        throw new Error(`Unknown events operation: ${op ?? '(none)'}`)
      }
      case 'metrics': {
        const kind = rest[0]
        const [name, labels, value] = args as [
          string,
          Record<string, string> | undefined,
          number,
        ]
        const m = this.facilities.metrics
        if (kind === 'counter.add') m.counter(name, labels).add(value)
        else if (kind === 'gauge.set') m.gauge(name, labels).set(value)
        else if (kind === 'histogram.observe')
          m.histogram(name, labels).observe(value)
        else throw new Error(`Unknown metrics operation: ${kind ?? '(none)'}`)
        return undefined
      }
      case 'config': {
        if (rest[0] === 'get') {
          return this.facilities.config.get(String(args[0]), args[1])
        }
        throw new Error(
          `Worker config only supports get (snapshot is read-only): ${rest[0] ?? '(none)'}`,
        )
      }
      case 'extensions': {
        if (rest[0] === 'contribute') {
          this.facilities.extensions?.contribute(
            this.pluginId,
            String(args[0]),
            args[1],
          )
          return undefined
        }
        throw new Error(
          `Unsupported worker extensions operation: ${rest[0] ?? '(none)'}`,
        )
      }
      default:
        throw new Error(`Unsupported worker context domain: ${domain}`)
    }
  }

  private async rpc(
    hook: string,
    args: unknown[],
    timeoutMs: number,
  ): Promise<unknown> {
    const worker = this.worker
    if (!worker)
      throw new KernelError('E_GENERIC', `Worker not started: ${this.pluginId}`)

    const id = this.seq++
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new TimeoutError(`Worker hook ${this.pluginId}.${hook}`, timeoutMs),
        )
      }, timeoutMs)
      if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      // On timeout the pending entry is already deleted, so a late result is dropped.
    })
    worker.postMessage({ t: HOST_TO_WORKER.Call, id, hook, args })
    return await promise
  }
}
