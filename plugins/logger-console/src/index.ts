/**
 * logger-console 插件 —— 可观测性（日志）是插件（docs/02 §M.1，动机 #8）。
 *
 * 通过 `log.sink` 能力向内核 LogService 注册一个控制台 sink。
 * 内核完全不知道"日志写到哪里"——这正是"一切皆插件"的体现。
 */

import { KernelTokens, ServiceToken } from 'rem2-kernel';
import type {
  Logger,
  LogEntry,
  LogSink,
  Plugin,
  PluginContext,
  PluginManifest,
} from 'rem2-kernel';

/** 控制台 sink：把结构化日志格式化为单行。 */
class ConsoleLogSink implements LogSink {
  readonly name = 'console';

  write(entry: LogEntry): void {
    const ts = new Date(entry.ts).toISOString();
    const data = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
    const line = `[${ts}] ${entry.level.toUpperCase().padEnd(5)} (${entry.scope}) ${entry.msg}${data}`;
    if (entry.level === 'error' || entry.level === 'fatal') {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }

  async flush(): Promise<void> {
    // 控制台无缓冲，无需 flush。
  }
}

/** 对内核 LogService 的最小结构类型。 */
export interface LogServiceLike {
  addSink(sink: LogSink): void;
  removeSink(name: string): void;
  child(scope: string, pluginId?: string): Logger;
}

/** 与内核 KernelTokens.Log 相同 id 的令牌（插件侧声明，用于解析）。 */
export const LogServiceToken: ServiceToken<LogServiceLike> =
  ServiceToken.create<LogServiceLike>({
    id: KernelTokens.Log.id,
    describe: '内核日志服务',
  });

/**
 * 插件实现。
 */
export default class LoggerConsolePlugin implements Plugin {
  readonly manifest: PluginManifest = {
    id: 'com.rem2.logger-console',
    name: 'Console Logger',
    version: '1.0.0',
    entry: 'src/index.ts',
    capabilities: ['log.sink'],
    compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
    author: 'rem2-team',
    description: '把内核日志输出到控制台',
    tags: ['observability', 'logging'],
  };

  private sink: ConsoleLogSink | null = null;
  private logService: LogServiceLike | null = null;

  async onStart(ctx: PluginContext): Promise<void> {
    const log = ctx.services.tryResolve(LogServiceToken);
    if (!log) {
      ctx.log.warn('未找到内核 LogService，logger-console 进入降级');
      return;
    }

    this.logService = log;
    this.sink = new ConsoleLogSink();
    log.addSink(this.sink);
    ctx.log.info('控制台日志 sink 已注册');
  }

  async onStop(ctx: PluginContext, reason: string): Promise<void> {
    if (this.logService && this.sink) {
      this.logService.removeSink(this.sink.name);
    }
    this.sink = null;
    this.logService = null;
    ctx.log.info(`控制台日志 sink 已注销（${reason}）`);
  }
}
