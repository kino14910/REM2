/**
 * 追踪服务（docs/01 的最小实现）。
 *
 * 内核提供 Tracer：span 先在内存中聚合，flush 时分发给所有已注册的
 * TraceExporter（exporter 是插件，契约见 contracts/tracing.ts）。
 *
 * 设计取舍：
 * - span 只在 `end()` 时入缓冲，避免长 span 未结束时 exporter 看到半截数据。
 * - 缓冲区有上限（默认 1024 条），溢出丢弃最旧记录，防止内存膨胀。
 * - exporter 错误被隔离（单个 exporter 失败不影响其他 exporter 与内核）。
 */

import type {
  Span,
  SpanData,
  TraceExporter,
  Tracer,
} from '../contracts/tracing.js';

/** 追踪服务选项。 */
export interface TracingServiceOptions {
  /** 内存缓冲上限（超出后丢弃最旧 span）。 */
  maxBufferedSpans?: number;
}

class SpanImpl implements Span {
  private readonly startTs = Date.now();
  private readonly attributes: Record<string, unknown> = {};
  private ended = false;

  constructor(
    private readonly name: string,
    attrs: Record<string, unknown> | undefined,
    private readonly onEnd: (data: SpanData) => void,
  ) {
    if (attrs) Object.assign(this.attributes, attrs);
  }

  setAttribute(key: string, value: unknown): void {
    if (this.ended) return;
    this.attributes[key] = value;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.onEnd({
      name: this.name,
      startTs: this.startTs,
      endTs: Date.now(),
      attributes: { ...this.attributes },
    });
  }
}

/**
 * 追踪服务。
 */
export class TracingService implements Tracer {
  private readonly exporters = new Map<string, TraceExporter>();
  private readonly buffer: SpanData[] = [];
  private readonly maxBuffered: number;
  private droppedCount = 0;

  constructor(opts: TracingServiceOptions = {}) {
    this.maxBuffered = opts.maxBufferedSpans ?? 1024;
  }

  /** 注册 exporter（幂等：同名覆盖）。 */
  registerExporter(exporter: TraceExporter): void {
    this.exporters.set(exporter.name, exporter);
  }

  /** 注销 exporter。 */
  unregisterExporter(name: string): void {
    this.exporters.delete(name);
  }

  listExporters(): string[] {
    return Array.from(this.exporters.keys()).sort();
  }

  startSpan(name: string, attrs?: Record<string, unknown>): Span {
    return new SpanImpl(name, attrs, (data) => this.record(data));
  }

  /** 已缓冲的 span（测试/调试）。 */
  bufferedSpans(): ReadonlyArray<SpanData> {
    return this.buffer;
  }

  /** 因缓冲溢出丢弃的 span 数。 */
  get dropped(): number {
    return this.droppedCount;
  }

  /** 冲刷：把缓冲的 span 分发给所有 exporter 并清空缓冲。 */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    for (const exporter of this.exporters.values()) {
      try {
        await exporter.export(batch);
      } catch {
        // 隔离：单个 exporter 失败不影响其他 exporter。
      }
    }
  }

  /** 记录一条完成的 span。 */
  private record(data: SpanData): void {
    if (this.buffer.length >= this.maxBuffered) {
      this.buffer.shift();
      this.droppedCount += 1;
    }
    this.buffer.push(data);
  }
}
