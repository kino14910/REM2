/**
 * 集成测试 · 硬依赖失败级联（docs/01）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel/kernel.js';
import { materializePlugins } from '../fixtures/fake-kernel.js';

describe('integration · hard-dependency-fail', () => {
  let cleanup: () => Promise<void>;
  beforeEach(() => {
    cleanup = async () => undefined;
  });
  afterEach(async () => {
    await cleanup();
  });

  it('硬依赖缺失 → 依赖者不启动（failed）', async () => {
    const fx = await materializePlugins([
      {
        id: 'com.rem2.dependent',
        dependencies: { 'com.rem2.missing': '^1.0.0' },
      },
    ]);
    cleanup = fx.cleanup;

    const kernel = new Kernel({ roots: [fx.root], onResolveError: 'graceful' });
    const result = await kernel.start();

    expect(result.started).not.toContain('com.rem2.dependent');
    expect(kernel.issues.some((i) => i.code === 'E_MISSING_DEPENDENCY')).toBe(
      true,
    );

    await kernel.shutdown();
  });

  it('硬依赖版本不符 → 依赖者不启动', async () => {
    const fx = await materializePlugins([
      { id: 'com.rem2.base', version: '1.0.0' },
      { id: 'com.rem2.dependent', dependencies: { 'com.rem2.base': '^2.0.0' } },
    ]);
    cleanup = fx.cleanup;

    const kernel = new Kernel({ roots: [fx.root], onResolveError: 'graceful' });
    const result = await kernel.start();

    expect(result.started).toContain('com.rem2.base');
    expect(result.started).not.toContain('com.rem2.dependent');
    expect(kernel.issues.some((i) => i.code === 'E_VERSION_MISMATCH')).toBe(
      true,
    );

    await kernel.shutdown();
  });

  it('硬依赖运行期启动失败 → 依赖者级联不启动', async () => {
    const fx = await materializePlugins([
      { id: 'com.rem2.base', behavior: 'throw' },
      { id: 'com.rem2.dependent', dependencies: { 'com.rem2.base': '^1.0.0' } },
    ]);
    cleanup = fx.cleanup;

    const kernel = new Kernel({ roots: [fx.root] });
    const result = await kernel.start();

    expect(result.failed).toContain('com.rem2.base');
    expect(result.failed).toContain('com.rem2.dependent');

    await kernel.shutdown();
  });
});
