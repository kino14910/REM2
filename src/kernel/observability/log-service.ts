/**
 * 日志服务（docs/01，动机 #8）。
 *
 * 内核只负责产日志 + 分发给 sink；"日志写到哪里"（控制台/文件/远程）是插件的事。
 * `addSink` 由提供 `log.sink` 能力的插件调用。
 */

import type {
  LogEntry,
  LogLevel,
  LogSink,
  Logger,
} from '../contracts/logging.js';
import { LOG_LEVEL_ORDER } from '../contracts/logging.js';
import { NullLogSink } from './null-sink.js';

/**
 * 作用域日志器实现。
 */
class ScopedLogger implements Logger {
  constructor(
    private readonly service: LogService,
    private readonly scope: string,
    private readonly pluginId?: string,
  ) {}

  trace(msg: string, data?: Record<string, unknown>): void {
    this.log('trace', msg, data);
  }
  debug(msg: string, data?: Record<string, unknown>): void {
    this.log('debug', msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.log('info', msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.log('warn', msg, data);
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.log('error', msg, data);
  }
  fatal(msg: string, data?: Record<string, unknown>): void {
    this.log('fatal', msg, data);
  }

  private log(
    level: LogLevel,
    msg: string,
    data?: Record<string, unknown>,
  ): void {
    this.service.dispatch({
      ts: Date.now(),
      level,
      scope: this.scope,
      ...(this.pluginId ? { pluginId: this.pluginId } : {}),
      msg,
      ...(data ? { data } : {}),
    });
  }
}

/**
 * 日志服务。
 */
export class LogService {
  private level: LogLevel = 'info';
  private readonly sinks = new Map<string, LogSink>();
  private droppedCount = 0;

  constructor(initialLevel: LogLevel = 'info') {
    this.level = initialLevel;
    // 默认挂一个 NullSink，保证 dispatch 永远有承接者（避免 undefined 判断）。
    this.sinks.set('null', new NullLogSink());
  }

  /** 设置最低日志级别。 */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  /** 添加 sink（幂等：同名覆盖）。 */
  addSink(sink: LogSink): void {
    this.sinks.set(sink.name, sink);
  }

  /** 移除 sink。 */
  removeSink(name: string): void {
    this.sinks.delete(name);
  }

  listSinks(): string[] {
    return Array.from(this.sinks.keys()).sort();
  }

  /** 创建作用域日志器。 */
  child(scope: string, pluginId?: string): Logger {
    return new ScopedLogger(this, scope, pluginId);
  }

  /** 分发一条日志（内部/供 Logger 调用）。 */
  dispatch(entry: LogEntry): void {
    if (LOG_LEVEL_ORDER[entry.level] < LOG_LEVEL_ORDER[this.level]) {
      return;
    }
    if (this.sinks.size === 0) {
      this.droppedCount += 1;
      return;
    }
    for (const sink of this.sinks.values()) {
      try {
        const result = sink.write(entry);
        // sink 若返回 Promise，异步错误隔离，不影响其他 sink。
        if (result && typeof (result as Promise<void>).catch === 'function') {
          void (result as Promise<void>).catch(() => {
            this.droppedCount += 1;
          });
        }
      } catch {
        this.droppedCount += 1;
      }
    }
  }

  /** 冲刷所有 sink。 */
  async flush(): Promise<void> {
    for (const sink of this.sinks.values()) {
      if (typeof sink.flush === 'function') {
        try {
          await sink.flush();
        } catch {
          // 忽略单个 sink 的 flush 错误。
        }
      }
    }
  }

  get dropped(): number {
    return this.droppedCount;
  }
}
