export interface Span {
  setAttribute(key: string, value: unknown): void
  end(): void
}

export interface SpanData {
  name: string
  startTs: number
  endTs: number
  attributes: Record<string, unknown>
}

export interface Tracer {
  startSpan(name: string, attrs?: Record<string, unknown>): Span
}

/** Span exporter (provided by plugins). */
export interface TraceExporter {
  readonly name: string
  export(spans: SpanData[]): void | Promise<void>
}
