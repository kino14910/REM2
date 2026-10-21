/**
 * Host defaults are registered through the extension point registry rather
 * than ad-hoc registration APIs, so every replaceable host capability has
 * an explicit extension point declaration.
 */

import type { LogService } from './log-service.js'
import type { MetricsService } from './metrics-service.js'
import type { TracingService } from './tracing-service.js'
import type { ExtensionPointRegistry } from '../extensions/registry.js'
import { NullLogSink } from './null-sink.js'
import { NoopMetricSink } from './noop-metrics-sink.js'
import { ReadOnlyMemoryConfigProvider } from '../config/memory-provider.js'
import type { LogSink } from '../contracts/logging.js'
import type { MetricSink } from '../contracts/metrics.js'
import type { TraceExporter, SpanData } from '../contracts/tracing.js'
import type { ConfigProvider } from '../contracts/config.js'

/** Built-in span buffering exporter (host default for `trace.exporter`). */
class BufferedTraceExporter implements TraceExporter {
  readonly name = 'buffered'
  private readonly spans: SpanData[] = []

  export(spans: SpanData[]): void {
    this.spans.push(...spans.map(s => ({ ...s })))
  }

  take(): SpanData[] {
    return this.spans.splice(0, this.spans.length)
  }
}

/**
 * Must be called before any plugin contributions are registered (plugin
 * contributions coexist with host defaults in the multi-contribution slot).
 */
export function registerHostSinks(
  extensions: ExtensionPointRegistry,
  services: {
    log: LogService
    metrics: MetricsService
    tracer: TracingService
  },
): { traceExporter: BufferedTraceExporter } {
  const nullSink = new NullLogSink()
  const noopSink = new NoopMetricSink()
  const traceExporter = new BufferedTraceExporter()

  // Ensure dispatch always has a sink to fall back on (avoids undefined checks across the kernel).
  services.log.addSink(nullSink)
  services.metrics.addSink(noopSink)

  extensions.registerHostDefault('log.sink', {
    contributionId: 'kernel.null',
    impl: nullSink as LogSink,
  })
  extensions.registerHostDefault('metrics.sink', {
    contributionId: 'kernel.noop',
    impl: noopSink as MetricSink,
  })
  extensions.registerHostDefault('trace.exporter', {
    contributionId: 'kernel.buffered',
    impl: traceExporter,
  })

  return { traceExporter }
}

/** Register the host default in-memory config layer (`{app:{name:'rem2'}}`). */
export function registerHostConfigLayer(
  extensions: ExtensionPointRegistry,
): void {
  extensions.registerHostDefault('config.provider', {
    contributionId: 'kernel.defaults',
    impl: new ReadOnlyMemoryConfigProvider({
      app: { name: 'rem2' },
    }) as ConfigProvider,
  })
}
