/**
 * 指标契约（纯类型）。见 docs/01
 */

/** 标签集合。 */
export type Labels = Record<string, string>;

/** 单条指标记录。 */
export type MetricRecord =
  | { kind: 'counter'; name: string; value: number; labels: Labels }
  | { kind: 'gauge'; name: string; value: number; labels: Labels }
  | { kind: 'histogram'; name: string; value: number; labels: Labels };

/** 指标接收器（插件提供的落地方）。 */
export interface MetricSink {
  readonly name: string;
  record(m: MetricRecord): void | Promise<void>;
}

/** 计数器。 */
export interface Counter {
  add(value: number, labels?: Labels): void;
}

/** 仪表盘。 */
export interface Gauge {
  set(value: number, labels?: Labels): void;
}

/** 直方图。 */
export interface Histogram {
  observe(value: number, labels?: Labels): void;
}

/**
 * 指标 API（`PluginContext.metrics` 的类型）。
 */
export interface MetricsApi {
  counter(name: string, labels?: Labels): Counter;
  gauge(name: string, labels?: Labels): Gauge;
  histogram(name: string, labels?: Labels): Histogram;
}

/** 内核自动产出的基础指标名（常量）。 */
export const KERNEL_METRICS = {
  lifecycleDuration: 'kernel.plugin.lifecycle.duration',
  pluginState: 'kernel.plugin.state',
  eventEmitCount: 'kernel.event.emit.count',
  eventHandlerError: 'kernel.event.handler.error',
  serviceResolveCount: 'kernel.service.resolve.count',
  capabilityDenied: 'kernel.capability.denied',
  configProviderError: 'kernel.config.provider.error',
} as const;
