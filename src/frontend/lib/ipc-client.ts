/**
 * `window.rem2` 的类型化**唯一封装**（docs/04 §2）。
 *
 * 所有 IPC 调用必须经此，理由：
 * ① 屏蔽 channel 名与 id 匹配细节；
 * ② 给 `window.rem2` 一个编译期形状（preload 用 contextBridge 注入，TS 看不见）；
 * ③ 未来加审计/重试只需改这一处。
 */

/** preload 通过 contextBridge 暴露的对象形状（与 `host/electron/preload.ts` 对齐）。 */
export interface Rem2Bridge {
  invoke(method: string, args?: unknown): Promise<unknown>;
  onEvent(event: string, handler: (payload: unknown) => void): () => void;
}

declare global {
  interface Window {
    rem2?: Rem2Bridge;
  }
}

export interface IpcClient {
  /** 调用一个白名单方法。 */
  request<T>(method: string, args?: unknown): Promise<T>;
  /** 订阅一个白名单事件，返回退订函数（供 `$effect` 清理）。 */
  subscribe(event: string, handler: (payload: unknown) => void): () => void;
  /** preload 是否可用（纯浏览器/测试环境下为 false）。 */
  readonly available: boolean;
}

/** 活跃订阅计数：便于 `beforeunload` 时统一退订（R8 的泄漏缓解）。 */
let activeSubscriptions = 0;

export const ipc: IpcClient = {
  get available(): boolean {
    return typeof window !== 'undefined' && !!window.rem2;
  },

  async request<T>(method: string, args?: unknown): Promise<T> {
    if (!window.rem2) {
      throw new Error('preload 桥不可用（REM2_BRIDGE_MISSING）');
    }
    return (await window.rem2.invoke(method, args)) as T;
  },

  subscribe(event: string, handler: (payload: unknown) => void): () => void {
    if (!window.rem2) return () => undefined;
    activeSubscriptions += 1;
    const off = window.rem2.onEvent(event, handler);
    return () => {
      activeSubscriptions -= 1;
      off();
    };
  },
};

/** 当前活跃订阅数（测试/调试用）。 */
export function subscriptionCount(): number {
  return activeSubscriptions;
}
