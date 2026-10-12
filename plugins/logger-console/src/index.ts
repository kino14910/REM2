/**
 * logger-console 插件 —— 可观测性（日志）是插件。
 *
 * 通过 `log.sink` 扩展点向内核贡献一个控制台 sink。
 * 内核完全不知道「日志写到哪里」——这正是「一切皆插件」的体现。
 *
 * 形态：唯一形态 `export default definePlugin(manifest, setup)`。
 */

import { definePlugin, defineToken, KernelTokens } from 'rem2-kernel';
import type { Logger, LogEntry, LogSink, PluginContext } from 'rem2-kernel';

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
export const LogServiceToken = defineToken<LogServiceLike>({
  id: KernelTokens.Log.id,
  describe: '内核日志服务',
});

export default definePlugin(
  { id: 'com.rem2.logger-console', name: 'Console Logger', version: '1.0.0' },
  (ctx: PluginContext) => {
    return {
      async onStart(): Promise<void> {
        const log = ctx.services.tryResolve(LogServiceToken);
        if (!log) {
          ctx.log.warn('未找到内核 LogService，logger-console 进入降级');
          return;
        }

        // 唯一的贡献入口：扩展点注册表（P3）。不再是 api.registerCapability。
        ctx.extensions.contribute<LogSink>('log.sink', {
          contributionId: 'console',
          impl: new ConsoleLogSink(),
        });
        ctx.log.info('控制台日志 sink 已注册（log.sink 扩展点）');
      },

      async onStop(hookCtx: PluginContext, reason: string): Promise<void> {
        // 贡献由内核在卸载时按 pluginId 强制回收（P6），插件无需手动清理。
        hookCtx.log.info(`控制台日志 sink 已注销（${reason}）`);
      },
    };
  },
);
