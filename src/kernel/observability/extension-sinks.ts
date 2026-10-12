/**
 * log / metrics / trace 三个 sink 扩展点的桥。
 *
 * 之前 `LogService.addSink` / `MetricsService.addSink` / `TracingService.registerExporter`
 * 是三个独立的旁路注册入口；现在它们统一改为**经扩展点注册表**，
 * 从而满足 P3「任何宿主提供的可替换能力必须有显式扩展点声明」。
 */

import type { LogService } from './log-service.js';
import type { MetricsService } from './metrics-service.js';
import type { TracingService } from './tracing-service.js';
import type { ExtensionPointRegistry } from '../extensions/registry.js';
import { NullLogSink } from './null-sink.js';
import { NoopMetricSink } from './noop-metrics-sink.js';
import { ReadOnlyMemoryConfigProvider } from '../config/memory-provider.js';
import type { LogSink } from '../contracts/logging.js';
import type { MetricSink } from '../contracts/metrics.js';
import type { TraceExporter, SpanData } from '../contracts/tracing.js';
import type { ConfigProvider } from '../contracts/config.js';

/** 内置的 span 缓冲 exporter（`trace.exporter` 的宿主默认实现）。 */
class BufferedTraceExporter implements TraceExporter {
  readonly name = 'buffered';
  private readonly spans: SpanData[] = [];

  export(spans: SpanData[]): void {
    this.spans.push(...spans.map((s) => ({ ...s })));
  }

  take(): SpanData[] {
    return this.spans.splice(0, this.spans.length);
  }
}

/**
 * 注册宿主默认的 sink 实现。
 *
 * 必须在任何插件贡献之前调用（插件贡献会与宿主默认共存于多贡献槽）。
 */
export function registerHostSinks(
  extensions: ExtensionPointRegistry,
  services: { log: LogService; metrics: MetricsService; tracer: TracingService },
): { traceExporter: BufferedTraceExporter } {
  const nullSink = new NullLogSink();
  const noopSink = new NoopMetricSink();
  const traceExporter = new BufferedTraceExporter();

  // 保证 dispatch 永远有承接者（避免内核各处写 undefined 判断）。
  services.log.addSink(nullSink);
  services.metrics.addSink(noopSink);

  extensions.registerHostDefault('log.sink', {
    contributionId: 'kernel.null',
    impl: nullSink as LogSink,
  });
  extensions.registerHostDefault('metrics.sink', {
    contributionId: 'kernel.noop',
    impl: noopSink as MetricSink,
  });
  extensions.registerHostDefault('trace.exporter', {
    contributionId: 'kernel.buffered',
    impl: traceExporter,
  });

  return { traceExporter };
}

/** 注册宿主默认的内存配置层（`{app:{name:'rem2'}}`）。 */
export function registerHostConfigLayer(extensions: ExtensionPointRegistry): void {
  extensions.registerHostDefault('config.provider', {
    contributionId: 'kernel.defaults',
    impl: new ReadOnlyMemoryConfigProvider({ app: { name: 'rem2' } }) as ConfigProvider,
  });
}
