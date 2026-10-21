import type { MetricRecord, MetricSink } from '../contracts/metrics.js'

export class NoopMetricSink implements MetricSink {
  readonly name = 'noop'

  record(_m: MetricRecord): void {
    void _m
  }
}

/** In-memory metric sink for tests. */
export class MemoryMetricSink implements MetricSink {
  readonly name = 'memory'
  private readonly records: MetricRecord[] = []

  record(m: MetricRecord): void {
    this.records.push(m)
  }

  getRecords(): ReadonlyArray<MetricRecord> {
    return this.records
  }

  findByKind(kind: MetricRecord['kind']): MetricRecord[] {
    return this.records.filter(r => r.kind === kind)
  }

  clear(): void {
    this.records.length = 0
  }
}
