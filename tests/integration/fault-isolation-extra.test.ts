/**
 * 集成测试 · 故障隔离补充（docs/02 §E：单插件失败不崩内核）。
 *
 * 补充既有 fault-isolation.test.ts 未覆盖的路径：
 * - onStop 抛错时，内核 shutdown 不崩且其余插件正常停止。
 * - onConfigure（Initialize，fatal 阶段）抛错 → 该插件 Failed，其余插件正常。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel/kernel.js';
import { PluginState } from '../../src/kernel/types.js';
import {
  createTmpPluginsDir,
  type TmpPluginsDir,
} from '../helpers/tmp-plugins-dir.js';

/** 生成一个内联 JS 插件源码（manifest 内联，无内核依赖）。 */
function jsPlugin(id: string, hooks: string): string {
  return `
export default {
  manifest: {
    id: ${JSON.stringify(id)},
    name: ${JSON.stringify(id)},
    version: '1.0.0',
    entry: 'index.js',
    compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
  },
  ${hooks}
};
`;
}

describe('integration · fault-isolation-extra', () => {
  let tmp: TmpPluginsDir | undefined;

  afterEach(async () => {
    await tmp?.cleanup();
    tmp = undefined;
  });

  it('onStop 抛错 → shutdown 不崩，其余插件正常停止', async () => {
    tmp = await createTmpPluginsDir();
    await tmp.writePlugin(
      { id: 'com.qa.good' },
      jsPlugin('com.qa.good', 'async onStart() {}'),
      'index.js',
    );
    await tmp.writePlugin(
      { id: 'com.qa.stopthrow' },
      jsPlugin(
        'com.qa.stopthrow',
        'async onStart() {}, async onStop() { throw new Error("stop boom"); }',
      ),
      'index.js',
    );

    const kernel = new Kernel({ roots: [tmp.root] });
    const result = await kernel.start();
    expect(result.started).toEqual(
      expect.arrayContaining(['com.qa.good', 'com.qa.stopthrow']),
    );

    await expect(kernel.shutdown()).resolves.toBeUndefined();
    expect(kernel.isStarted()).toBe(false);
    expect(kernel.pluginRegistry.getLoaded('com.qa.good')!.state).toBe(
      PluginState.Stopped,
    );
  });

  it('onConfigure 抛错（fatal）→ 该插件 Failed，其余插件正常启动', async () => {
    tmp = await createTmpPluginsDir();
    await tmp.writePlugin(
      { id: 'com.qa.good' },
      jsPlugin('com.qa.good', 'async onStart() {}'),
      'index.js',
    );
    await tmp.writePlugin(
      { id: 'com.qa.badcfg' },
      jsPlugin(
        'com.qa.badcfg',
        'async onConfigure() { throw new Error("configure boom"); }',
      ),
      'index.js',
    );

    const kernel = new Kernel({ roots: [tmp.root] });
    const result = await kernel.start();

    expect(result.started).toContain('com.qa.good');
    expect(result.failed).toContain('com.qa.badcfg');
    expect(kernel.pluginRegistry.getLoaded('com.qa.badcfg')!.state).toBe(
      PluginState.Failed,
    );
    expect(kernel.isStarted()).toBe(true);

    await kernel.shutdown();
  });
});
