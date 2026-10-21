export type Labels = Record<string, string>

export type MetricRecord =
  | { kind: 'counter'; name: string; value: number; labels: Labels }
  | { kind: 'gauge'; name: string; value: number; labels: Labels }
  | { kind: 'histogram'; name: string; value: number; labels: Labels }

/** Metric sink (backend provided by plugins). */
export interface MetricSink {
  readonly name: string
  record(m: MetricRecord): void | Promise<void>
}

export interface Counter {
  add(value: number, labels?: Labels): void
}

export interface Gauge {
  set(value: number, labels?: Labels): void
}

export interface Histogram {
  observe(value: number, labels?: Labels): void
}

/** Metrics API (the type of `PluginContext.metrics`). */
export interface MetricsApi {
  counter(name: string, labels?: Labels): Counter
  gauge(name: string, labels?: Labels): Gauge
  histogram(name: string, labels?: Labels): Histogram
}

/** Basic metric names produced automatically by the kernel. */
export const KERNEL_METRICS = {
  lifecycleDuration: 'kernel.plugin.lifecycle.duration',
  pluginState: 'kernel.plugin.state',
  eventEmitCount: 'kernel.event.emit.count',
  eventHandlerError: 'kernel.event.handler.error',
  serviceResolveCount: 'kernel.service.resolve.count',
  capabilityDenied: 'kernel.capability.denied',
  configProviderError: 'kernel.config.provider.error',
} as const
