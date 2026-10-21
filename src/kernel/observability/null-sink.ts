import type { LogEntry, LogSink } from '../contracts/logging.js'

export class NullLogSink implements LogSink {
  readonly name = 'null'

  write(_entry: LogEntry): void {
    void _entry
  }

  async flush(): Promise<void> {}
}

/** In-memory log sink for tests. */
export class MemoryLogSink implements LogSink {
  readonly name = 'memory'
  private readonly entries: LogEntry[] = []

  constructor(private readonly limit = 1000) {}

  write(entry: LogEntry): void {
    this.entries.push(entry)
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit)
    }
  }

  getEntries(): ReadonlyArray<LogEntry> {
    return this.entries
  }

  filterByLevel(level: LogEntry['level']): LogEntry[] {
    return this.entries.filter(e => e.level === level)
  }

  clear(): void {
    this.entries.length = 0
  }
}
