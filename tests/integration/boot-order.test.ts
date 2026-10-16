/**
 * 集成测试 · 确定性启动顺序（docs/01）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel/kernel.js';
import { materializePlugins } from '../fixtures/fake-kernel.js';

describe('integration · boot-order', () => {
  let root = '';
  let cleanup: () => Promise<void>;

  beforeEach(() => {
    cleanup = async () => undefined;
  });
  afterEach(async () => {
    await cleanup();
  });

  it('硬依赖先于依赖者启动，且顺序确定', async () => {
    const fx = await materializePlugins([
      { id: 'com.rem2.aaa', dependencies: { 'com.rem2.bbb': '^1.0.0' } },
      { id: 'com.rem2.bbb', dependencies: { 'com.rem2.ccc': '^1.0.0' } },
      { id: 'com.rem2.ccc' },
    ]);
    root = fx.root;
    cleanup = fx.cleanup;

    const kernel = new Kernel({ roots: [root], onResolveError: 'graceful' });
    const result = await kernel.start();

    const idx = (id: string): number => result.loadOrder.indexOf(id);
    expect(idx('com.rem2.ccc')).toBeLessThan(idx('com.rem2.bbb'));
    expect(idx('com.rem2.bbb')).toBeLessThan(idx('com.rem2.aaa'));
    expect(result.started.length).toBe(3);
    expect(result.failed).toEqual([]);

    await kernel.shutdown();
  });

  it('无依赖插件按 id 字典序确定加载', async () => {
    const fx = await materializePlugins([
      { id: 'com.rem2.zeta' },
      { id: 'com.rem2.alpha' },
      { id: 'com.rem2.mid' },
    ]);
    root = fx.root;
    cleanup = fx.cleanup;

    const kernel = new Kernel({ roots: [root] });
    const result = await kernel.start();

    expect(result.loadOrder).toEqual([
      'com.rem2.alpha',
      'com.rem2.mid',
      'com.rem2.zeta',
    ]);

    await kernel.shutdown();
  });

  it('同一输入集多次启动顺序一致', async () => {
    const fx = await materializePlugins([
      { id: 'com.rem2.a', dependencies: { 'com.rem2.c': '^1.0.0' } },
      { id: 'com.rem2.b', dependencies: { 'com.rem2.c': '^1.0.0' } },
      { id: 'com.rem2.c' },
      { id: 'com.rem2.d' },
    ]);
    root = fx.root;
    cleanup = fx.cleanup;

    const k1 = new Kernel({ roots: [root] });
    const r1 = await k1.start();
    await k1.shutdown();

    const k2 = new Kernel({ roots: [root] });
    const r2 = await k2.start();
    await k2.shutdown();

    expect(r1.loadOrder).toEqual(r2.loadOrder);
  });
});
