/**
 * 集成测试 · 可观测性（docs/01：日志/指标/健康都是可插拔基础设施）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel/kernel.js';
import { KernelTokens } from '../../src/kernel/contracts/kernel-tokens.js';
import { MemoryLogSink } from '../../src/kernel/observability/null-sink.js';
import { MemoryMetricSink } from '../../src/kernel/observability/noop-metrics-sink.js';
import { materializePlugins } from '../fixtures/fake-kernel.js';

describe('integration · observability', () => {
  let cleanup: () => Promise<void>;
  beforeEach(() => {
    cleanup = async () => undefined;
  });
  afterEach(async () => {
    await cleanup();
  });

  it('LogService 可挂载 sink 并接收日志', async () => {
    const kernel = new Kernel({ roots: [] });
    const sink = new MemoryLogSink();
    const log = kernel.root.resolve(KernelTokens.Log) as {
      addSink(s: unknown): void;
      child(scope: string): { info(msg: string): void };
    };
    log.addSink(sink);
    log.child('test').info('hello observability');

    expect(sink.getEntries().some((e) => e.msg === 'hello observability')).toBe(
      true,
    );
    await kernel.shutdown();
  });

  it('MetricsService 可挂载 sink 并接收指标', async () => {
    const kernel = new Kernel({ roots: [] });
    const sink = new MemoryMetricSink();
    const metrics = kernel.root.resolve(KernelTokens.Metrics) as unknown as {
      addSink(s: unknown): void;
      counter(name: string): { add(v: number): void };
    };
    metrics.addSink(sink);
    metrics.counter('test.counter').add(3);

    expect(
      sink.findByKind('counter').some((r) => r.name === 'test.counter'),
    ).toBe(true);
    await kernel.shutdown();
  });

  it('生命周期阶段会产出指标', async () => {
    const fx = await materializePlugins([{ id: 'com.rem2.metric' }]);
    cleanup = fx.cleanup;

    const kernel = new Kernel({ roots: [fx.root] });
    const sink = new MemoryMetricSink();
    (
      kernel.root.resolve(KernelTokens.Metrics) as unknown as {
        addSink(s: unknown): void;
      }
    ).addSink(sink);

    await kernel.start();
    expect(sink.findByKind('histogram').length).toBeGreaterThan(0);

    await kernel.shutdown();
  });

  it('健康报告包含内核版本与运行时长', async () => {
    const kernel = new Kernel({ roots: [] });
    await kernel.start();
    const report = await kernel.health();
    expect(report.kernel.version).toBe('1.0.0');
    expect(report.kernel.uptimeMs).toBeGreaterThanOrEqual(0);
    await kernel.shutdown();
  });
});
