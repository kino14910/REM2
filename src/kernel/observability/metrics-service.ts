/**
 * 指标服务（docs/02 §I.2，动机 #8）。
 */

import type {
  Counter,
  Gauge,
  Histogram,
  Labels,
  MetricRecord,
  MetricSink,
  MetricsApi,
} from '../contracts/metrics.js';
import { NoopMetricSink } from './noop-metrics-sink.js';

class CounterImpl implements Counter {
  constructor(
    private readonly service: MetricsService,
    private readonly name: string,
    private readonly labels: Labels,
  ) {}

  add(value: number, labels?: Labels): void {
    this.service.dispatch({
      kind: 'counter',
      name: this.name,
      value,
      labels: { ...this.labels, ...labels },
    });
  }
}

class GaugeImpl implements Gauge {
  constructor(
    private readonly service: MetricsService,
    private readonly name: string,
    private readonly labels: Labels,
  ) {}

  set(value: number, labels?: Labels): void {
    this.service.dispatch({
      kind: 'gauge',
      name: this.name,
      value,
      labels: { ...this.labels, ...labels },
    });
  }
}

class HistogramImpl implements Histogram {
  constructor(
    private readonly service: MetricsService,
    private readonly name: string,
    private readonly labels: Labels,
  ) {}

  observe(value: number, labels?: Labels): void {
    this.service.dispatch({
      kind: 'histogram',
      name: this.name,
      value,
      labels: { ...this.labels, ...labels },
    });
  }
}

/**
 * 指标服务。
 */
export class MetricsService implements MetricsApi {
  private readonly sinks = new Map<string, MetricSink>();

  constructor() {
    this.sinks.set('noop', new NoopMetricSink());
  }

  /** 添加 sink（幂等）。 */
  addSink(sink: MetricSink): void {
    this.sinks.set(sink.name, sink);
  }

  removeSink(name: string): void {
    this.sinks.delete(name);
  }

  listSinks(): string[] {
    return Array.from(this.sinks.keys()).sort();
  }

  counter(name: string, labels?: Labels): Counter {
    return new CounterImpl(this, name, labels ?? {});
  }

  gauge(name: string, labels?: Labels): Gauge {
    return new GaugeImpl(this, name, labels ?? {});
  }

  histogram(name: string, labels?: Labels): Histogram {
    return new HistogramImpl(this, name, labels ?? {});
  }

  /** 分发一条指标（错误隔离）。 */
  dispatch(m: MetricRecord): void {
    for (const sink of this.sinks.values()) {
      try {
        const result = sink.record(m);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          void (result as Promise<void>).catch(() => undefined);
        }
      } catch {
        // 忽略单个 sink 错误。
      }
    }
  }
}
