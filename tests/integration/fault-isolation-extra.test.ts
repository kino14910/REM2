/**
 * 集成测试 · 故障隔离补充（docs/01：单插件失败不崩内核）。
 *
 * 补充既有 fault-isolation.test.ts 未覆盖的路径：
 * - onStop 抛错时，内核 shutdown 不崩且其余插件正常停止。
 * - onConfigure（Initialize，fatal 阶段）抛错 → 该插件 Failed，其余插件正常。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel/kernel.js';
import {
  createTmpPluginsDir,
  type TmpPluginsDir,
} from '../helpers/tmp-plugins-dir.js';

/**
 * 生成一个内联 JS 插件源码：**唯一形态** = default 导出工厂函数。
 *
 * 权威 manifest 写在 plugin.json 里（内核只认它），因此源码里无需重复声明。
 */
function jsPlugin(hooks: string): string {
  return `
export default function factory(ctx) {
  void ctx;
  return {
    ${hooks}
  };
}
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
      jsPlugin('async onStart() {}'),
      'index.js',
    );
    await tmp.writePlugin(
      { id: 'com.qa.stopthrow' },
      jsPlugin(
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
      'Stopped',
    );
  });

  it('onConfigure 抛错（fatal）→ 该插件 Failed，其余插件正常启动', async () => {
    tmp = await createTmpPluginsDir();
    await tmp.writePlugin(
      { id: 'com.qa.good' },
      jsPlugin('async onStart() {}'),
      'index.js',
    );
    await tmp.writePlugin(
      { id: 'com.qa.badcfg' },
      jsPlugin('async onConfigure() { throw new Error("configure boom"); }'),
      'index.js',
    );

    const kernel = new Kernel({ roots: [tmp.root] });
    const result = await kernel.start();

    expect(result.started).toContain('com.qa.good');
    expect(result.failed).toContain('com.qa.badcfg');
    expect(kernel.pluginRegistry.getLoaded('com.qa.badcfg')!.state).toBe(
      'Failed',
    );
    expect(kernel.isStarted()).toBe(true);

    await kernel.shutdown();
  });
});
