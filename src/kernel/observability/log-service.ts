/**
 * The kernel only produces logs and dispatches them to sinks; where logs
 * are written (console/file/remote) is each plugin's concern.
 */

import type {
  LogEntry,
  LogLevel,
  LogSink,
  Logger,
} from '../contracts/logging.js'
import { LOG_LEVEL_ORDER } from '../contracts/logging.js'
import { NullLogSink } from './null-sink.js'

class ScopedLogger implements Logger {
  constructor(
    private readonly service: LogService,
    private readonly scope: string,
    private readonly pluginId?: string,
  ) {}

  trace(msg: string, data?: Record<string, unknown>): void {
    this.log('trace', msg, data)
  }
  debug(msg: string, data?: Record<string, unknown>): void {
    this.log('debug', msg, data)
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.log('info', msg, data)
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.log('warn', msg, data)
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.log('error', msg, data)
  }
  fatal(msg: string, data?: Record<string, unknown>): void {
    this.log('fatal', msg, data)
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
    })
  }
}

export class LogService {
  private level: LogLevel = 'info'
  private readonly sinks = new Map<string, LogSink>()
  private droppedCount = 0

  constructor(initialLevel: LogLevel = 'info') {
    this.level = initialLevel
    // A NullSink is installed by default so dispatch always has a sink.
    this.sinks.set('null', new NullLogSink())
  }

  setLevel(level: LogLevel): void {
    this.level = level
  }

  getLevel(): LogLevel {
    return this.level
  }

  addSink(sink: LogSink): void {
    this.sinks.set(sink.name, sink)
  }

  removeSink(name: string): void {
    this.sinks.delete(name)
  }

  listSinks(): string[] {
    return Array.from(this.sinks.keys()).sort()
  }

  child(scope: string, pluginId?: string): Logger {
    return new ScopedLogger(this, scope, pluginId)
  }

  dispatch(entry: LogEntry): void {
    if (LOG_LEVEL_ORDER[entry.level] < LOG_LEVEL_ORDER[this.level]) {
      return
    }
    if (this.sinks.size === 0) {
      this.droppedCount += 1
      return
    }
    for (const sink of this.sinks.values()) {
      try {
        const result = sink.write(entry)
        // Async sink errors are isolated and do not affect other sinks.
        if (result && typeof (result as Promise<void>).catch === 'function') {
          void (result as Promise<void>).catch(() => {
            this.droppedCount += 1
          })
        }
      } catch {
        this.droppedCount += 1
      }
    }
  }

  async flush(): Promise<void> {
    for (const sink of this.sinks.values()) {
      if (typeof sink.flush === 'function') {
        try {
          await sink.flush()
        } catch {
          // Ignore flush errors from individual sinks.
        }
      }
    }
  }

  get dropped(): number {
    return this.droppedCount
  }
}
