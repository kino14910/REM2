/**
 * hello-command 插件 —— 业务功能是插件。
 *
 * - 通过 `command.provide` 扩展点提供命令处理器。
 * - **软依赖** config-json：缺失时用默认问候语，插件**仍正常启动**（degraded 而非 failed）。
 */

import { Topics } from 'rem2-kernel';
import { definePlugin, defineToken } from 'rem2-kernel';
import type {
  EventBus,
  HealthStatus,
  PluginContext,
  Unsubscribe,
} from 'rem2-kernel';

/** Greeter 服务契约。 */
export interface Greeter {
  greet(name: string): string;
}

/** Greeter 服务令牌（本插件导出）。 */
export const GreeterToken = defineToken<Greeter>({
  id: 'plugin.hello.greeter',
  capability: 'command.provide',
  describe: '问候服务',
});

/** Greeter 实现。 */
class GreeterImpl implements Greeter {
  constructor(private greeting: string) {}

  setGreeting(greeting: string): void {
    this.greeting = greeting;
  }

  greet(name: string): string {
    return `${this.greeting}, ${name}!`;
  }
}

export default definePlugin(
  { id: 'com.rem2.hello-command', name: 'Hello Command', version: '1.0.0' },
  (ctx: PluginContext) => {
    let greeter: GreeterImpl | null = null;
    const unsubs: Unsubscribe[] = [];
    let startedFlag = false;
    /** 是否检测到软依赖 config-json（用于健康状态）。 */
    let configPluginPresent = false;

    return {
      async onConfigure(): Promise<void> {
        // 软依赖运行期探测：config-json 是否存在。
        configPluginPresent = ctx.plugins.has('com.rem2.config-json');
        greeter = new GreeterImpl(
          ctx.config.get<string>('app.greeting', 'Hello'),
        );
      },

      async onStart(): Promise<void> {
        if (!greeter) {
          greeter = new GreeterImpl('Hello');
        }

        // 注册服务（默认不泄漏到父容器，需显式 api.export）。
        ctx.services.registerInstance<Greeter>(GreeterToken, greeter);
        ctx.api.export(GreeterToken, { capability: 'command.provide' });

        const bus = ctx.events;
        // 订阅命令执行事件（供 emit 广播）。
        unsubs.push(
          bus.on<{ command: string; args?: unknown }>(
            Topics.CommandExecute,
            async (p) => {
              if (!p || p.command !== 'hello') return;
              const g = ctx.services.resolve(GreeterToken);
              await bus.emit(Topics.CommandResult, {
                ok: true,
                output: g.greet('rem2'),
              });
            },
          ),
        );
        // 注册 RPC 响应者（供 IPC 桥 request）。
        unsubs.push(
          bus.respond<
            { command: string; args?: unknown },
            { ok: boolean; output?: string; error?: string }
          >(Topics.CommandExecute, (p) => {
            if (!p || p.command !== 'hello') {
              return {
                ok: false,
                error: `未知命令：${p?.command ?? '(empty)'}`,
              };
            }
            const g = ctx.services.resolve(GreeterToken);
            return { ok: true, output: g.greet('rem2') };
          }),
        );

        // 唯一的贡献入口：扩展点注册表（P3）。
        ctx.extensions.contribute('command.provide', {
          contributionId: 'hello',
          impl: async (args: unknown) => {
            const g = ctx.services.resolve(GreeterToken);
            return {
              ok: true,
              output: g.greet(
                String((args as { name?: string })?.name ?? 'rem2'),
              ),
            };
          },
        });

        startedFlag = true;
        ctx.log.info(
          `hello-command 已启动（softdep config-json=${configPluginPresent}）`,
        );
      },

      async onStop(hookCtx: PluginContext, reason: string): Promise<void> {
        for (const u of unsubs) u();
        unsubs.length = 0;
        startedFlag = false;
        hookCtx.log.info(`hello-command 已停止（${reason}）`);
      },

      onUnload(hookCtx: PluginContext): void {
        hookCtx.api.unexport(GreeterToken);
      },

      onHealthCheck(): HealthStatus {
        if (!startedFlag || unsubs.length === 0) return 'degraded';
        return configPluginPresent ? 'healthy' : 'degraded';
      },
    };
  },
);

/** 供其他插件解析的令牌导出（与内核 KernelTokens.EventBus 同 id）。 */
export type { EventBus };
