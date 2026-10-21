/**
 * Kernel Tracer: spans are aggregated in memory and dispatched to all
 * registered TraceExporters on flush.
 *
 * Design trade-offs:
 * - Spans enter the buffer only in `end()`, so exporters never observe
 *   half-finished spans.
 * - The buffer is bounded (default 1024 entries); overflow drops the oldest
 *   span to prevent unbounded memory growth.
 */

import type {
  Span,
  SpanData,
  TraceExporter,
  Tracer,
} from '../contracts/tracing.js'

export interface TracingServiceOptions {
  maxBufferedSpans?: number
}

class SpanImpl implements Span {
  private readonly startTs = Date.now()
  private readonly attributes: Record<string, unknown> = {}
  private ended = false

  constructor(
    private readonly name: string,
    attrs: Record<string, unknown> | undefined,
    private readonly onEnd: (data: SpanData) => void,
  ) {
    if (attrs) Object.assign(this.attributes, attrs)
  }

  setAttribute(key: string, value: unknown): void {
    if (this.ended) return
    this.attributes[key] = value
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    this.onEnd({
      name: this.name,
      startTs: this.startTs,
      endTs: Date.now(),
      attributes: { ...this.attributes },
    })
  }
}

export class TracingService implements Tracer {
  private readonly exporters = new Map<string, TraceExporter>()
  private readonly buffer: SpanData[] = []
  private readonly maxBuffered: number
  private droppedCount = 0

  constructor(opts: TracingServiceOptions = {}) {
    this.maxBuffered = opts.maxBufferedSpans ?? 1024
  }

  registerExporter(exporter: TraceExporter): void {
    this.exporters.set(exporter.name, exporter)
  }

  unregisterExporter(name: string): void {
    this.exporters.delete(name)
  }

  listExporters(): string[] {
    return Array.from(this.exporters.keys()).sort()
  }

  startSpan(name: string, attrs?: Record<string, unknown>): Span {
    return new SpanImpl(name, attrs, data => this.record(data))
  }

  bufferedSpans(): ReadonlyArray<SpanData> {
    return this.buffer
  }

  get dropped(): number {
    return this.droppedCount
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const batch = this.buffer.splice(0, this.buffer.length)
    for (const exporter of this.exporters.values()) {
      try {
        await exporter.export(batch)
      } catch {
        // Isolated: a failing exporter must not affect the others.
      }
    }
  }

  private record(data: SpanData): void {
    if (this.buffer.length >= this.maxBuffered) {
      this.buffer.shift()
      this.droppedCount += 1
    }
    this.buffer.push(data)
  }
}
