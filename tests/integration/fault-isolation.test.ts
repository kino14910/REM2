/**
 * 集成测试 · 故障隔离（docs/01：单插件失败不崩内核）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel/kernel.js';
import { materializePlugins } from '../fixtures/fake-kernel.js';

describe('integration · fault-isolation', () => {
  let cleanup: () => Promise<void>;
  beforeEach(() => {
    cleanup = async () => undefined;
  });
  afterEach(async () => {
    await cleanup();
  });

  it('一个插件 onStart 抛错 → 其余插件照常启动，内核不崩', async () => {
    const fx = await materializePlugins([
      { id: 'com.rem2.good.a' },
      { id: 'com.rem2.bad', behavior: 'throw' },
      { id: 'com.rem2.good.b' },
    ]);
    cleanup = fx.cleanup;

    const kernel = new Kernel({ roots: [fx.root] });
    const result = await kernel.start();

    expect(result.started).toContain('com.rem2.good.a');
    expect(result.started).toContain('com.rem2.good.b');
    expect(result.failed).toContain('com.rem2.bad');
    expect(kernel.pluginRegistry.getLoaded('com.rem2.bad')!.state).toBe(
      'Failed',
    );
    expect(kernel.isStarted()).toBe(true);

    await kernel.shutdown();
  });

  it('启动超时被隔离，其余插件正常', async () => {
    const fx = await materializePlugins([
      { id: 'com.rem2.fast' },
      { id: 'com.rem2.slow', behavior: { delayMs: 500 } },
    ]);
    cleanup = fx.cleanup;

    const kernel = new Kernel({ roots: [fx.root], startTimeoutMs: 40 });
    const result = await kernel.start();

    expect(result.started).toContain('com.rem2.fast');
    expect(result.failed).toContain('com.rem2.slow');

    await kernel.shutdown();
  });

  it('健康报告反映失败插件为 unhealthy', async () => {
    const fx = await materializePlugins([
      { id: 'com.rem2.ok' },
      { id: 'com.rem2.bad', behavior: 'throw' },
    ]);
    cleanup = fx.cleanup;

    const kernel = new Kernel({ roots: [fx.root] });
    await kernel.start();
    const report = await kernel.health();

    expect(report.status).toBe('unhealthy');
    const bad = report.plugins.find((p) => p.id === 'com.rem2.bad');
    expect(bad?.status).toBe('unhealthy');

    await kernel.shutdown();
  });
});
