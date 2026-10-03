/**
 * Worker 隔离宿主（docs/02 §C.6，动机 #6 的进程级错误隔离）。
 *
 * 当插件 manifest 声明 `isolation: 'worker'` 时，内核不直接 import 插件代码，
 * 而是由本宿主在独立的 `worker_threads` 线程中加载并驱动它：
 *
 * - 内核 ↔ Worker 之间通过结构化克隆消息通信（RPC）。
 * - Worker 崩溃 / 死循环 / `process.exit()` 不会拖垮内核主线程：
 *   内核收到 `exit`/`error` 后把该插件置为 Failed，其余插件不受影响。
 * - 诚实声明：Worker 隔离是**故障隔离**，不是安全沙箱——Worker 内代码仍有完整
 *   Node 能力。安全边界仍由内核侧的 CapabilityGuard 把关（插件能触达的内核设施
 *   只有经 RPC 代理的 log / config 快照 / events / metrics）。
 *
 * 跨边界的上下文能力（有意收窄）：
 * - `ctx.log` / `ctx.config`（init 快照 + 变更推送）/ `ctx.events`（emit/on/request）
 *   / `ctx.metrics`：经 RPC 代理，可用。
 * - `ctx.services` / `ctx.api` / `ctx.plugins`：不可跨线程代理，Worker 内调用抛错。
 *   Worker 插件之间的协作必须走事件总线（这也是"能力即服务"的强制解耦）。
 */

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { EventBus, Unsubscribe } from '../contracts/event-bus.js';
import type { LogService } from '../observability/log-service.js';
import type { MetricsApi } from '../contracts/metrics.js';
import type { ConfigService } from '../config/config-service.js';
import type { Candidate } from '../discovery/candidate.js';
import { resolveEntry } from '../loader/module-resolver.js';
import { KernelError, TimeoutError } from '../errors.js';
import { WORKER_BOOTSTRAP_SOURCE } from './worker-bootstrap.js';

/** 宿主侧依赖的内核设施。 */
export interface WorkerHostFacilities {
  events: EventBus;
  config: ConfigService;
  logService: LogService;
  metrics: MetricsApi;
  /** Worker 意外退出回调（code 为退出码；内核据此置 Failed）。 */
  onUnexpectedExit: (
    pluginId: string,
    code: number | null,
    error?: string,
  ) => void;
}

/** Worker → 内核的上下文调用请求。 */
interface CtxCallMessage {
  t: 'ctx';
  id: number;
  path: string[];
  args: unknown[];
}

/** 待决 RPC。 */
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/**
 * Worker 插件宿主：内核侧代理。
 */
export class WorkerPluginHost {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  /** worker 订阅的事件：subId → 内核侧退订函数。 */
  private readonly eventSubs = new Map<number, Unsubscribe>();
  private configUnsub: Unsubscribe | null = null;
  private expectingExit = false;
  private failedError: string | null = null;

  constructor(
    private readonly candidate: Candidate,
    private readonly facilities: WorkerHostFacilities,
  ) {}

  get pluginId(): string {
    return this.candidate.manifest.id;
  }

  /**
   * 调用 Worker 内插件的钩子（懒启动：首次调用时才 spawn Worker）。
   */
  async callHook(
    hook: string,
    args: unknown[] = [],
    timeoutMs = DEFAULT_HOOK_TIMEOUT_MS,
  ): Promise<unknown> {
    await this.ensureStarted();
    if (this.failedError) {
      throw new KernelError(
        'E_LOAD_FAILED',
        `Worker 插件已失败：${this.pluginId} - ${this.failedError}`,
      );
    }
    return await this.rpc(hook, args, timeoutMs);
  }

  /** 终止 Worker（幂等）。 */
  async terminate(): Promise<void> {
    this.expectingExit = true;
    this.configUnsub?.();
    this.configUnsub = null;
    for (const unsub of this.eventSubs.values()) unsub();
    this.eventSubs.clear();
    const worker = this.worker;
    this.worker = null;
    this.ready = null;
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        // 终止失败不影响内核。
      }
    }
    // 拒绝所有未决 RPC，避免悬挂。
    for (const p of this.pending.values()) {
      p.reject(new KernelError('E_GENERIC', `Worker 已终止：${this.pluginId}`));
    }
    this.pending.clear();
  }

  // ───────────────────────── 内部 ─────────────────────────

  private async ensureStarted(): Promise<void> {
    if (this.ready) return await this.ready;

    const { manifest, rootDir } = this.candidate;
    const { specifier } = resolveEntry(rootDir, manifest.entry, manifest.id);

    this.ready = (async () => {
      const worker = new Worker(WORKER_BOOTSTRAP_SOURCE, {
        eval: true,
        name: `plugin:${manifest.id}`,
      });
      this.worker = worker;
      this.attachWorkerListeners(worker);

      const readyPromise = this.waitForReady(worker);
      worker.postMessage({
        t: 'init',
        entrySpecifier: specifier,
        manifest,
        rootDir: path.resolve(rootDir),
        configSnapshot: this.facilities.config.snapshotOf(),
        permissions: {
          granted: [],
          denied: [],
        },
      });
      await readyPromise;

      // 配置变更 → 推送新快照到 Worker。
      this.configUnsub = this.facilities.config.onDidChange(() => {
        worker.postMessage({
          t: 'config',
          snapshot: this.facilities.config.snapshotOf(),
        });
      });
    })();

    try {
      await this.ready;
    } catch (error) {
      this.ready = null;
      await this.terminate();
      throw error;
    }
  }

  /** 等待 Worker 初始化完成（ready / init-error / 提前退出）。 */
  private waitForReady(worker: Worker): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onMessage = (msg: { t?: string; message?: string }): void => {
        if (msg.t === 'ready') {
          cleanup();
          resolve();
        } else if (msg.t === 'init-error') {
          cleanup();
          reject(
            new KernelError(
              'E_LOAD_FAILED',
              `Worker 插件初始化失败：${this.pluginId} - ${msg.message ?? '未知'}`,
            ),
          );
        }
      };
      const onExit = (code: number): void => {
        cleanup();
        reject(
          new KernelError(
            'E_LOAD_FAILED',
            `Worker 初始化前退出：${this.pluginId}（code=${code}）`,
          ),
        );
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(
          new KernelError(
            'E_LOAD_FAILED',
            `Worker 初始化错误：${this.pluginId} - ${err.message}`,
          ),
        );
      };
      const cleanup = (): void => {
        worker.off('message', onMessage);
        worker.off('exit', onExit);
        worker.off('error', onError);
      };
      worker.on('message', onMessage);
      worker.on('exit', onExit);
      worker.on('error', onError);
    });
  }

  /** 常驻监听（初始化完成后）：RPC 结果、上下文调用、事件订阅、意外退出。 */
  private attachWorkerListeners(worker: Worker): void {
    worker.on('message', (msg: Record<string, unknown>) => {
      switch (msg.t) {
        case 'result': {
          const id = msg.id as number;
          const p = this.pending.get(id);
          if (!p) return;
          this.pending.delete(id);
          if (msg.ok) p.resolve(msg.value);
          else
            p.reject(new Error((msg.error as string) ?? 'Worker 钩子执行失败'));
          return;
        }
        case 'ctx': {
          void this.handleCtxCall(worker, msg as unknown as CtxCallMessage);
          return;
        }
        case 'subscribe': {
          const subId = msg.subId as number;
          const pattern = msg.pattern as string;
          const unsub = this.facilities.events.on(pattern, (payload) => {
            worker.postMessage({ t: 'event', subId, payload });
          });
          this.eventSubs.set(subId, unsub);
          return;
        }
        case 'unsub': {
          const subId = msg.subId as number;
          this.eventSubs.get(subId)?.();
          this.eventSubs.delete(subId);
          return;
        }
        default:
      }
    });

    worker.on('error', (err) => {
      this.failedError = err.message;
      this.facilities.onUnexpectedExit(this.pluginId, null, err.message);
    });

    worker.on('exit', (code) => {
      if (!this.expectingExit) {
        this.failedError = `Worker 意外退出（code=${code}）`;
        this.facilities.onUnexpectedExit(this.pluginId, code);
      }
    });
  }

  /** 处理 Worker → 内核的上下文调用（log/events/metrics）。 */
  private async handleCtxCall(
    worker: Worker,
    msg: CtxCallMessage,
  ): Promise<void> {
    const reply = (ok: boolean, value?: unknown, error?: string): void => {
      worker.postMessage({ t: 'ctx-result', id: msg.id, ok, value, error });
    };
    try {
      const [domain, ...rest] = msg.path;
      const result = await this.dispatchCtx(domain ?? '', rest, msg.args);
      reply(true, result);
    } catch (error) {
      reply(false, undefined, (error as Error).message);
    }
  }

  /** 上下文调用分派（白名单：仅 log / events / metrics / config.get 可用）。 */
  private async dispatchCtx(
    domain: string,
    rest: string[],
    args: unknown[],
  ): Promise<unknown> {
    const log = this.facilities.logService.child(
      `plugin:${this.pluginId}`,
      this.pluginId,
    );
    switch (domain) {
      case 'log': {
        const level = rest[0] as
          | 'trace'
          | 'debug'
          | 'info'
          | 'warn'
          | 'error'
          | 'fatal';
        const fn = log[level];
        if (typeof fn !== 'function') throw new Error(`未知日志级别：${level}`);
        fn.call(
          log,
          String(args[0] ?? ''),
          args[1] as Record<string, unknown> | undefined,
        );
        return undefined;
      }
      case 'events': {
        const op = rest[0];
        if (op === 'emit') {
          await this.facilities.events.emit(String(args[0]), args[1]);
          return undefined;
        }
        if (op === 'request') {
          const timeoutMs = typeof args[2] === 'number' ? args[2] : 5000;
          return await this.facilities.events.request(
            String(args[0]),
            args[1],
            { timeoutMs },
          );
        }
        throw new Error(`未知事件操作：${op ?? '(none)'}`);
      }
      case 'metrics': {
        const kind = rest[0];
        const [name, labels, value] = args as [
          string,
          Record<string, string> | undefined,
          number,
        ];
        const m = this.facilities.metrics;
        if (kind === 'counter.add') m.counter(name, labels).add(value);
        else if (kind === 'gauge.set') m.gauge(name, labels).set(value);
        else if (kind === 'histogram.observe')
          m.histogram(name, labels).observe(value);
        else throw new Error(`未知指标操作：${kind ?? '(none)'}`);
        return undefined;
      }
      case 'config': {
        if (rest[0] === 'get') {
          return this.facilities.config.get(String(args[0]), args[1]);
        }
        throw new Error(
          `Worker 配置仅支持 get（快照只读）：${rest[0] ?? '(none)'}`,
        );
      }
      default:
        throw new Error(`Worker 上下文不支持的能力域：${domain}`);
    }
  }

  /** 内核 → Worker 的钩子 RPC（带超时）。 */
  private async rpc(
    hook: string,
    args: unknown[],
    timeoutMs: number,
  ): Promise<unknown> {
    const worker = this.worker;
    if (!worker)
      throw new KernelError('E_GENERIC', `Worker 未启动：${this.pluginId}`);

    const id = this.seq++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new TimeoutError(`Worker 钩子 ${this.pluginId}.${hook}`, timeoutMs),
        );
      }, timeoutMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      // 超时后清理：结果到达时 pending 已删，自然丢弃。
    });
    worker.postMessage({ t: 'call', id, hook, args });
    return await promise;
  }
}
