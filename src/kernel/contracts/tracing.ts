/**
 * 追踪契约（纯类型，可选）。见 docs/01
 */

/** 追踪 span。 */
export interface Span {
  setAttribute(key: string, value: unknown): void;
  end(): void;
}

/** span 导出数据。 */
export interface SpanData {
  name: string;
  startTs: number;
  endTs: number;
  attributes: Record<string, unknown>;
}

/** 追踪器。 */
export interface Tracer {
  startSpan(name: string, attrs?: Record<string, unknown>): Span;
}

/** span 导出器（插件）。 */
export interface TraceExporter {
  readonly name: string;
  export(spans: SpanData[]): void | Promise<void>;
}
