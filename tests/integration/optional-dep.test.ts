/**
 * 集成测试 · 软依赖（optionalDependencies）语义（docs/01）。
 *
 * 软依赖缺失时插件仍应正常启动（degraded 而非 failed）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel/kernel.js';
import { materializePlugins } from '../fixtures/fake-kernel.js';

describe('integration · optional-dependency', () => {
  let cleanup: () => Promise<void>;
  beforeEach(() => {
    cleanup = async () => undefined;
  });
  afterEach(async () => {
    await cleanup();
  });

  it('软依赖缺失 → 插件仍启动（非 failed）', async () => {
    const fx = await materializePlugins([
      {
        id: 'com.rem2.app',
        optionalDependencies: { 'com.rem2.absent': '^1.0.0' },
      },
    ]);
    cleanup = fx.cleanup;

    const kernel = new Kernel({ roots: [fx.root] });
    const result = await kernel.start();

    expect(result.failed).toEqual([]);
    expect(result.degraded).toContain('com.rem2.app');
    expect(result.started).not.toContain('com.rem2.app');

    const issues = kernel.issues.filter((i) => i.pluginId === 'com.rem2.app');
    expect(issues.some((i) => i.code === 'W_MISSING_OPTIONAL')).toBe(true);

    await kernel.shutdown();
  });

  it('软依赖存在 → 无告警，双插件正常启动', async () => {
    const fx = await materializePlugins([
      { id: 'com.rem2.base' },
      {
        id: 'com.rem2.app',
        optionalDependencies: { 'com.rem2.base': '^1.0.0' },
      },
    ]);
    cleanup = fx.cleanup;

    const kernel = new Kernel({ roots: [fx.root] });
    const result = await kernel.start();

    expect(result.started).toContain('com.rem2.base');
    expect(result.started).toContain('com.rem2.app');
    expect(kernel.pluginRegistry.getLoaded('com.rem2.app')!.state).toBe(
      'Active',
    );

    await kernel.shutdown();
  });
});
