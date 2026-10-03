/**
 * hello-command 插件 —— 业务功能是插件（docs/02 §M.3，动机 #1/#2/#4/#6）。
 *
 * - 提供 `command.provide` 能力：向内核服务注册表注册一个 `Greeter` 服务，
 *   并订阅 `command:execute` 事件。
 * - **软依赖** config-json：缺失时用默认问候语，插件**仍正常启动**（degraded 而非 failed）。
 */

import { KernelTokens, ServiceToken } from 'rem2-kernel';
import type {
  ConfigAccess,
  EventBus,
  HealthStatus,
  Plugin,
  PluginContext,
  PluginManifest,
  Unsubscribe,
} from 'rem2-kernel';

/** Greeter 服务契约。 */
export interface Greeter {
  greet(name: string): string;
}

/** Greeter 服务令牌（本插件导出）。 */
export const GreeterToken = ServiceToken.create<Greeter>({
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

/** 事件主题常量（插件自定义，内核不认识）。 */
const Topics = {
  CommandExecute: 'command:execute',
  CommandResult: 'command:result',
} as const;

/**
 * 插件实现。
 */
export default class HelloCommandPlugin implements Plugin {
  readonly manifest: PluginManifest = {
    id: 'com.rem2.hello-command',
    name: 'Hello Command',
    version: '1.0.0',
    entry: 'src/index.ts',
    optionalDependencies: { 'com.rem2.config-json': '^1.0.0' },
    capabilities: ['command.provide'],
    compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
    author: 'rem2-team',
    description: '注册 hello 命令',
    tags: ['command', 'demo'],
  };

  private greeter: GreeterImpl | null = null;
  private readonly unsubs: Unsubscribe[] = [];
  private startedFlag = false;
  /** 是否检测到软依赖 config-json（用于健康状态）。 */
  private configPluginPresent = false;

  async onConfigure(ctx: PluginContext): Promise<void> {
    // 软依赖运行期探测：config-json 是否存在。
    this.configPluginPresent = ctx.plugins.has('com.rem2.config-json');
    const greeting = ctx.config.get<string>('app.greeting', 'Hello');
    this.greeter = new GreeterImpl(greeting);
  }

  async onStart(ctx: PluginContext): Promise<void> {
    if (!this.greeter) {
      this.greeter = new GreeterImpl('Hello');
    }

    // 注册服务（默认不泄漏到父容器，需显式 api.export）。
    ctx.services.registerInstance(GreeterToken, this.greeter);
    ctx.api.export(GreeterToken, { capability: 'command.provide' });

    // 订阅命令执行事件（供 emit 广播），并注册 RPC 响应者（供 IPC 桥 request）。
    const bus = ctx.events as EventBus;
    this.unsubs.push(
      bus.on<{ command: string; args?: unknown }>(
        Topics.CommandExecute,
        async (p) => {
          if (!p || p.command !== 'hello') return;
          const greeter = ctx.services.resolve(GreeterToken);
          await bus.emit(Topics.CommandResult, {
            ok: true,
            output: greeter.greet('rem2'),
          });
        },
      ),
    );
    this.unsubs.push(
      bus.respond<{ command: string; args?: unknown }, { ok: boolean; output?: string; error?: string }>(
        Topics.CommandExecute,
        (p) => {
          if (!p || p.command !== 'hello') {
            return { ok: false, error: `未知命令：${p?.command ?? '(empty)'}` };
          }
          const greeter = ctx.services.resolve(GreeterToken);
          return { ok: true, output: greeter.greet('rem2') };
        },
      ),
    );

    this.startedFlag = true;
    ctx.log.info(
      `hello-command 已启动（softdep config-json=${this.configPluginPresent}）`,
    );
  }

  async onStop(ctx: PluginContext, reason: string): Promise<void> {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.startedFlag = false;
    ctx.log.info(`hello-command 已停止（${reason}）`);
  }

  onUnload(ctx: PluginContext): void {
    ctx.api.unexport(GreeterToken);
  }

  onHealthCheck(): HealthStatus {
    if (!this.startedFlag || this.unsubs.length === 0) return 'degraded';
    return this.configPluginPresent ? 'healthy' : 'degraded';
  }
}

/** 供其他插件/测试解析的令牌导出（与内核 KernelTokens.EventBus 同 id）。 */
export const EventBusToken: ServiceToken<EventBus> =
  ServiceToken.create<EventBus>({
    id: KernelTokens.EventBus.id,
    describe: '内核事件总线',
  });
export const ConfigToken: ServiceToken<ConfigAccess> =
  ServiceToken.create<ConfigAccess>({
    id: KernelTokens.Config.id,
    describe: '内核配置访问',
  });
