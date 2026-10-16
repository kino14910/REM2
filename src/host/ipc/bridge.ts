/**
 * IPC 桥：renderer 与内核之间**唯一**的通道（docs/04 §5）。
 *
 * 两个方向都是收窄的：
 * - 宿主 → 内核：`allowedMethods.has(method)` 精确判定，**不进入事件总线**。
 * - 内核 → 宿主：只转发 5 个白名单事件，且做 DTO 降维。
 *
 * 明确**不做**的两件事（docs/04 §5.1）：
 * ① 不把 `bus.emit` 暴露给 renderer（那会给 renderer 写侧能力）；
 * ② 不转发 `bus.on('*')`（那会泄露全部内部 topic）。
 */

import type { EventBus, Unsubscribe } from '../../kernel/contracts/event-bus.js';
import {
  ALLOWED_EVENT_SET,
  ALLOWED_METHOD_SET,
  Ipc,
  type IpcEventPayload,
  type IpcRequest,
  type IpcResponse,
} from './channels.js';

/** 宿主传输抽象（Electron 的 ipcRenderer / ipcMain 均可适配）。 */
export interface IpcTransport {
  /** 发送到对端。 */
  send(channel: string, payload: unknown): void;
  /** 订阅对端消息，返回退订函数。 */
  on(channel: string, handler: (payload: unknown) => void): () => void;
}

/** 内核 topic → 对外事件名的降维映射表（骨架：只声明，落点在 host/electron）。 */
export type EventForwardMap = ReadonlyArray<{
  topic: string;
  event: string;
  toDto: (payload: unknown) => unknown;
}>;

export class IpcBridge {
  private transport: IpcTransport | null = null;
  private unsubscribers: Unsubscribe[] = [];
  private readonly allowedMethods: ReadonlySet<string>;
  private readonly allowedEvents: ReadonlySet<string>;
  private readonly forwardMap: EventForwardMap;

  constructor(
    private readonly bus: EventBus,
    opts: {
      allowedMethods?: ReadonlySet<string>;
      allowedEvents?: ReadonlySet<string>;
      forwardMap?: EventForwardMap;
    } = {},
  ) {
    this.allowedMethods = opts.allowedMethods ?? ALLOWED_METHOD_SET;
    this.allowedEvents = opts.allowedEvents ?? ALLOWED_EVENT_SET;
    this.forwardMap = opts.forwardMap ?? [];
  }

  /** 绑定传输并开始双向转发。 */
  bind(transport: IpcTransport): void {
    this.unbind();
    this.transport = transport;

    // renderer → 内核
    this.unsubscribers.push(
      transport.on(Ipc.Invoke, (payload) => {
        void this.handleInvoke(payload);
      }),
    );

    // 内核 → renderer：只转发白名单 topic，且做 DTO 降维。
    for (const f of this.forwardMap) {
      this.unsubscribers.push(
        this.bus.on(f.topic, (payload) => {
          // 双保险：映射表里出现非白名单事件名时直接丢弃。
          if (!this.allowedEvents.has(f.event)) return;
          const dto: IpcEventPayload = { event: f.event, payload: f.toDto(payload) };
          this.transport?.send(Ipc.Event, dto);
        }),
      );
    }
  }

  unbind(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.transport = null;
  }

  /** 方法是否在白名单内（精确匹配）。 */
  isAllowed(method: string): boolean {
    return this.allowedMethods.has(method);
  }

  private async handleInvoke(payload: unknown): Promise<void> {
    const req = payload as Partial<IpcRequest> | null;
    if (!req || typeof req.method !== 'string') return;

    // 白名单校验：不在集合内的方法直接拒绝，**不进入内核事件总线**。
    if (!this.isAllowed(req.method)) {
      this.reply({
        id: req.id ?? '',
        ok: false,
        error: `方法被拒绝（不在 IPC 白名单内）：${req.method}`,
      });
      return;
    }

    try {
      const result = await this.bus.request(req.method, req.args, {
        timeoutMs: 5000,
      });
      this.reply({ id: req.id ?? '', ok: true, result });
    } catch (error) {
      this.reply({
        id: req.id ?? '',
        ok: false,
        error: (error as Error).message,
      });
    }
  }

  private reply(res: IpcResponse): void {
    this.transport?.send(Ipc.Invoke, res);
  }
}
