/**
 * 空日志接收器（内核默认 sink，动机 #8：不写任何地方的 sink 也是合法实现）。
 */

import type { LogEntry, LogSink } from '../contracts/logging.js';

/** 丢弃全部日志。 */
export class NullLogSink implements LogSink {
  readonly name = 'null';

  write(_entry: LogEntry): void {
    void _entry;
  }

  async flush(): Promise<void> {
    // no-op
  }
}

/** 内存日志接收器（测试用：保留最近 N 条）。 */
export class MemoryLogSink implements LogSink {
  readonly name = 'memory';
  private readonly entries: LogEntry[] = [];

  constructor(private readonly limit = 1000) {}

  write(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
  }

  getEntries(): ReadonlyArray<LogEntry> {
    return this.entries;
  }

  filterByLevel(level: LogEntry['level']): LogEntry[] {
    return this.entries.filter((e) => e.level === level);
  }

  clear(): void {
    this.entries.length = 0;
  }
}
