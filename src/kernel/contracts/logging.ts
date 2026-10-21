/**
 * The kernel only hands log entries to sinks; where they land is the plugin's
 * business.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface LogEntry {
  ts: number
  level: LogLevel
  scope: string
  pluginId?: string
  msg: string
  data?: Record<string, unknown>
}

export interface LogSink {
  readonly name: string
  write(entry: LogEntry): void | Promise<void>
  flush?(): Promise<void>
}

/** Scoped logger (obtained by plugins via `ctx.log`). */
export interface Logger {
  trace(msg: string, data?: Record<string, unknown>): void
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
  fatal(msg: string, data?: Record<string, unknown>): void
}

/** Numeric ordering of log levels (exported so the kernel and plugins share one scale). */
export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}
