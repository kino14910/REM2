/**
 * 日志契约（纯类型）。见 docs/01
 *
 * 关键：内核只负责把日志交给 sink；写到哪里是插件的事（动机 #8）。
 */

/** 日志级别。 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** 单条日志。 */
export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  pluginId?: string;
  msg: string;
  data?: Record<string, unknown>;
}

/** 日志接收器（插件提供的落地方）。 */
export interface LogSink {
  readonly name: string;
  write(entry: LogEntry): void | Promise<void>;
  flush?(): Promise<void>;
}

/** 作用域日志器（插件通过 `ctx.log` 获得）。 */
export interface Logger {
  trace(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  fatal(msg: string, data?: Record<string, unknown>): void;
}

/** 日志级别数值表（导出以确保内核与插件口径一致）。 */
export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};
