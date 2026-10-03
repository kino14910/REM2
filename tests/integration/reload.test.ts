/**
 * 集成测试 · 热插拔 / 热重载（docs/02 §C.5）。
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel/kernel.js';
import { PluginState } from '../../src/kernel/types.js';
import { materializePlugins } from '../fixtures/fake-kernel.js';

/** 覆写某插件目录下 index.js 的内容（模拟磁盘变更）。 */
async function overwritePluginEntry(
  root: string,
  pluginId: string,
  newSource: string,
): Promise<void> {
  const dir = path.join(root, pluginId.replace(/[^a-z0-9._-]/gi, '_'));
  await writeFile(path.join(dir, 'index.js'), newSource, 'utf8');
}

describe('integration · reload', () => {
  let cleanup: () => Promise<void>;
  beforeEach(() => {
    cleanup = async () => undefined;
  });
  afterEach(async () => {
    await cleanup();
  });

  it('reload 停止旧实例并重新启动', async () => {
    const fx = await materializePlugins([{ id: 'com.rem2.reloadable' }]);
    cleanup = fx.cleanup;

    const kernel = new Kernel({ roots: [fx.root] });
    await kernel.start();
    expect(kernel.pluginRegistry.getLoaded('com.rem2.reloadable')!.state).toBe(
      PluginState.Started,
    );

    await kernel.reload('com.rem2.reloadable');
    expect(kernel.pluginRegistry.getLoaded('com.rem2.reloadable')!.state).toBe(
      PluginState.Started,
    );

    await kernel.shutdown();
  });

  it('磁盘变更后 reload 采用新代码', async () => {
    const fx = await materializePlugins([
      { id: 'com.rem2.reloadable', health: 'healthy' },
    ]);
    cleanup = fx.cleanup;

    const kernel = new Kernel({ roots: [fx.root] });
    await kernel.start();

    // 改写源码：把健康状态改为 degraded。
    const newSource = `
const manifest = ${JSON.stringify({
      id: 'com.rem2.reloadable',
      name: 'com.rem2.reloadable',
      version: '1.0.0',
      entry: 'index.js',
      compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
    })};
const plugin = {
  manifest,
  async onStart() {},
  onHealthCheck() { return 'degraded'; },
};
export default plugin;
`;
    await overwritePluginEntry(fx.root, 'com.rem2.reloadable', newSource);

    await kernel.reload('com.rem2.reloadable');
    const report = await kernel.health();
    const info = report.plugins.find((p) => p.id === 'com.rem2.reloadable');
    expect(info?.status).toBe('degraded');

    await kernel.shutdown();
  });

  it('reload 未加载插件抛错', async () => {
    const kernel = new Kernel({ roots: [] });
    await kernel.start();
    await expect(kernel.reload('com.rem2.nope')).rejects.toThrow();
    await kernel.shutdown();
  });
});
