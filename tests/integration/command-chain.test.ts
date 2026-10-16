/**
 * 集成测试 · 命令链路（renderer → IPC 桥 → 内核 → 命令插件）。
 *
 * ★ 为什么需要这条（真实缺陷的复盘）：
 * 曾有一条 `main.ts` 给 `'command.execute'` 注册 responder，实现却是
 * `request(Topics.CommandExecute)` —— 而 `Topics.CommandExecute` 的**值就是**
 * `'command.execute'` 自身。于是 request 命中同一个 responder，无限递归，
 * 用户输入 `hello` 得到 `RangeError: Maximum call stack size exceeded`。
 *
 * 之前的单元测试全部测的是 EventBus 自己的 request/respond 配对，
 * 没有一个用例覆盖「IPC 白名单方法名 → 内核 topic 名」这段映射；
 * 而只要映射目标与来源相同，就会自递归。本用例把这段钉死。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel/kernel.js';
import { KernelTokens } from '../../src/kernel/contracts/kernel-tokens.js';
import { Topics } from '../../src/kernel/topics.js';
import { ALLOWED_METHOD_SET, Ipc } from '../../src/host/ipc/channels.js';
import { IpcBridge } from '../../src/host/ipc/bridge.js';
import type { EventBus } from '../../src/kernel/contracts/event-bus.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const BUILTIN_ROOT = path.join(PROJECT_ROOT, 'plugins-dist');

function createKernel(): Kernel {
  return new Kernel({
    id: 'rem2-command-chain',
    roots: [],
    builtinRoot: BUILTIN_ROOT,
    startTimeoutMs: 8000,
    stopTimeoutMs: 8000,
    legacyFallback: false,
    logLevel: 'error',
    initialConfig: { app: { greeting: 'Hello from rem2' } },
  });
}

describe('integration · 命令链路', () => {
  it('IPC 白名单的 command.execute 与内核 topic 同名（否则桥与插件对不上）', () => {
    // 这是「无响应者」缺陷的判据：桥用 ALLOWED_METHODS 里的名字去 request，
    // 插件 respond 的必须是同一个字符串。
    expect(ALLOWED_METHOD_SET.has(Topics.CommandExecute)).toBe(true);
  });

  it('hello 命令经内核总线得到成功响应', async () => {
    const kernel = createKernel();
    try {
      await kernel.start();
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus);

      const result = await bus.request<
        { command: string },
        { ok: boolean; output?: string }
      >(Topics.CommandExecute, { command: 'hello' }, { timeoutMs: 5000 });

      expect(result.ok).toBe(true);
      expect(result.output).toContain('rem2');
    } finally {
      await kernel.shutdown();
    }
  });

  it('未知命令返回错误而非无限递归', async () => {
    const kernel = createKernel();
    try {
      await kernel.start();
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus);

      const result = await bus.request<
        { command: string },
        { ok: boolean; error?: string }
      >(
        Topics.CommandExecute,
        { command: 'definitely-not-a-command' },
        { timeoutMs: 5000 },
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain('definitely-not-a-command');
    } finally {
      await kernel.shutdown();
    }
  });

  it('无命令插件时 request 抛 NoResponderError（不静默、不递归）', async () => {
    const kernel = new Kernel({
      id: 'rem2-no-command-plugin',
      roots: [],
      builtinRoot: path.join(
        PROJECT_ROOT,
        'tests',
        'fixtures',
        'empty-plugins',
      ),
      startTimeoutMs: 5000,
      stopTimeoutMs: 5000,
      legacyFallback: false,
      logLevel: 'error',
    });
    try {
      await kernel.start();
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus);

      await expect(
        bus.request(
          Topics.CommandExecute,
          { command: 'hello' },
          { timeoutMs: 3000 },
        ),
      ).rejects.toThrow(/无响应者/);
    } finally {
      await kernel.shutdown();
    }
  });

  it('经 IPC 桥走完整链路得到 hello 的成功响应', async () => {
    const kernel = createKernel();
    try {
      await kernel.start();
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus);

      const bridge = new IpcBridge(bus);
      const received: unknown[] = [];
      bridge.bind({
        send: (_ch, payload) => received.push(payload),
        on: (ch, handler) => {
          if (ch !== Ipc.Invoke) return () => undefined;
          return () => {
            void handler({
              id: 'chain-1',
              method: 'command.execute',
              args: { command: 'hello' },
            });
          };
        },
      });

      // renderer 侧等价调用：window.rem2.invoke('command.execute', { command: 'hello' })
      const response = await new Promise<{
        ok: boolean;
        result?: unknown;
        error?: string;
      }>((resolve) => {
        received.length = 0;
        void (
          bridge as unknown as {
            handleInvoke(payload: unknown): Promise<void>;
          }
        ).handleInvoke({
          id: 'chain-1',
          method: 'command.execute',
          args: { command: 'hello' },
        });
        setTimeout(() => resolve(received[0] as never), 1500);
      });

      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({ ok: true });
      bridge.unbind();
    } finally {
      await kernel.shutdown();
    }
  });

  it('★ 回归护栏：自递归转发器必须被捕获（曾导致 RangeError）', async () => {
    // 复现用户的真实时序：宿主 responder 注册于 kernel.start() **之前**
    // （main.ts:172 早于 :173），于是它的 seq 更小，`pickResponder` 优先选它，
    // 而它的实现是 request 同一个 topic → 无限递归 → Maximum call stack size exceeded。
    // 若将来有人把这条转发器加回来，本用例会红。
    const kernel = new Kernel({
      id: 'rem2-self-recursion',
      roots: [],
      builtinRoot: BUILTIN_ROOT,
      startTimeoutMs: 5000,
      stopTimeoutMs: 5000,
      legacyFallback: false,
      logLevel: 'error',
      initialConfig: { app: { greeting: 'Hello from rem2' } },
    });
    try {
      const busEarly = kernel.root.resolve<EventBus>(KernelTokens.EventBus);
      busEarly.respond<{ command: string }, unknown>(
        'command.execute',
        (args) =>
          busEarly.request(Topics.CommandExecute, args, { timeoutMs: 5000 }),
      );
      await kernel.start();
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus);

      const bridge = new IpcBridge(bus);
      const received: unknown[] = [];
      bridge.bind({
        send: (_ch, payload) => received.push(payload),
        on: (ch, handler) => {
          if (ch !== Ipc.Invoke) return () => undefined;
          return () => {
            void handler({
              id: 'recur-1',
              method: 'command.execute',
              args: { command: 'hello' },
            });
          };
        },
      });

      const response = await new Promise<{ ok: boolean; error?: string }>(
        (resolve) => {
          received.length = 0;
          void (
            bridge as unknown as {
              handleInvoke(payload: unknown): Promise<void>;
            }
          ).handleInvoke({
            id: 'recur-1',
            method: 'command.execute',
            args: { command: 'hello' },
          });
          setTimeout(() => resolve(received[0] as never), 1500);
        },
      );

      // 递归会以 RangeError 的形式被桥捕获成 error 响应 —— 这正是用户看到的现象。
      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/call stack/i);
      bridge.unbind();
    } finally {
      await kernel.shutdown();
    }
  });
});
