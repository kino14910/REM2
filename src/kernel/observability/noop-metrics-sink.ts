/**
 * 空指标接收器（默认，动机 #8）。
 */

import type { MetricRecord, MetricSink } from '../contracts/metrics.js';

/** 丢弃全部指标。 */
export class NoopMetricSink implements MetricSink {
  readonly name = 'noop';

  record(_m: MetricRecord): void {
    void _m;
  }
}

/** 内存指标接收器（测试用）。 */
export class MemoryMetricSink implements MetricSink {
  readonly name = 'memory';
  private readonly records: MetricRecord[] = [];

  record(m: MetricRecord): void {
    this.records.push(m);
  }

  getRecords(): ReadonlyArray<MetricRecord> {
    return this.records;
  }

  findByKind(kind: MetricRecord['kind']): MetricRecord[] {
    return this.records.filter((r) => r.kind === kind);
  }

  clear(): void {
    this.records.length = 0;
  }
}
