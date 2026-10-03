/**
 * IPC 桥（docs/02 §M.3：Electron 外壳是可选插件载体）。
 *
 * 把「宿主 IPC 传输」与「内核事件总线」解耦：
 * - `bind(transport)` 订阅宿主传入消息，转发到内核事件总线；
 * - 订阅内核 `ipc:response` / `ipc:broadcast`，回发宿主。
 *
 * 安全边界：renderer 侧 IPC 不可直达内核全部事件主题。
 * 默认仅放行 `command:*` 与 `health:*` 前缀；其余方法被拒绝并返回错误响应。
 * 这是"最小外壳"原则的体现：内核功能无限，外壳暴露有限。
 *
 * 内核本身完全不知道 IPC / Electron 的存在（内核零 Electron 依赖）。
 */

import type { EventBus } from '../../kernel/contracts/event-bus.js';
import { IpcTopics } from './ipc-topics.js';

/** 宿主传输抽象（Electron 的 ipcRenderer/ipcMain 均可适配）。 */
export interface IpcTransport {
  /** 发送到对端。 */
  send(channel: string, payload: unknown): void;
  /** 订阅对端消息，返回退订函数。 */
  on(channel: string, handler: (payload: unknown) => void): () => void;
}

/** IPC 请求负载。 */
export interface IpcRequest {
  id: string;
  method: string;
  args?: unknown;
}

/** IPC 桥。 */
export class IpcBridge {
  private transport: IpcTransport | null = null;
  private unsubscribers: Array<() => void> = [];
  /** 允许被外部调用的方法前缀（白名单）。 */
  private readonly allowedPrefixes: readonly string[];

  constructor(
    private readonly bus: EventBus,
    allowedPrefixes: readonly string[] = ['command:', 'health:'],
  ) {
    this.allowedPrefixes = allowedPrefixes;
  }

  /** 绑定传输并开始双向转发。 */
  bind(transport: IpcTransport): void {
    this.unbind();
    this.transport = transport;

    // 宿主 → 内核
    this.unsubscribers.push(
      transport.on(IpcTopics.Request, (payload) => {
        void this.handleRequest(payload);
      }),
    );

    // 内核 → 宿主（响应 & 广播）
    this.unsubscribers.push(
      this.bus.on(IpcTopics.Response, (payload) => {
        this.transport?.send(IpcTopics.Response, payload);
      }),
    );
    this.unsubscribers.push(
      this.bus.on(IpcTopics.Broadcast, (payload) => {
        this.transport?.send(IpcTopics.Broadcast, payload);
      }),
    );
  }

  /** 解绑传输。 */
  unbind(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    this.transport = null;
  }

  /** 判断方法是否在白名单内。 */
  private isAllowed(method: string): boolean {
    return this.allowedPrefixes.some((p) => method.startsWith(p));
  }

  /** 把宿主请求转换为内核事件。 */
  private async handleRequest(payload: unknown): Promise<void> {
    const req = payload as Partial<IpcRequest> | null;
    if (!req || typeof req.method !== 'string') return;

    // 白名单校验：不在允许前缀内的方法直接拒绝，不进入内核事件总线。
    if (!this.isAllowed(req.method)) {
      await this.bus.emit(IpcTopics.Response, {
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
      await this.bus.emit(IpcTopics.Response, {
        id: req.id ?? '',
        ok: true,
        result,
      });
    } catch (error) {
      await this.bus.emit(IpcTopics.Response, {
        id: req.id ?? '',
        ok: false,
        error: (error as Error).message,
      });
    }
  }
}
