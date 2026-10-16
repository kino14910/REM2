/**
 * 集成测试 · 能力/权限边界（docs/01）。
 *
 * 架构承诺：
 * - 未授权插件解析其他插件导出的服务 → 抛 `CapabilityDeniedError`（绝不静默返回 undefined）。
 * - 已授权插件可解析其他插件导出的服务（跨插件能力消费）。
 *
 * 采用真实 Kernel + 临时目录插件，端到端验证（非 mock）。
 * 注意：内核从 `plugin.json` 读取 manifest，故依赖/能力必须写入 manifest（而非仅插件源码内联）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel/kernel.js';
import {
  createTmpPluginsDir,
  type TmpPluginsDir,
} from '../helpers/tmp-plugins-dir.js';

const SVC_ID = 'plugin.qa.secret';
const CAP = 'command.provide';

/** 提供者：注册并导出（声明能力）一个服务。唯一形态 = default 导出工厂函数。 */
const PROVIDER_SOURCE = `
const TOKEN = { id: ${JSON.stringify(SVC_ID)} };
export default function factory(ctx) {
  return {
    async onStart() {
      ctx.services.registerInstance(TOKEN, { value: 42 });
      ctx.api.export(TOKEN, { capability: ${JSON.stringify(CAP)} });
    },
  };
}
`;

/** 消费者：硬依赖 provider（保证 provider 先启动），尝试跨插件解析。 */
const CONSUMER_SOURCE = `
const TOKEN = { id: ${JSON.stringify(SVC_ID)} };
export default function factory(ctx) {
  return {
    async onStart() {
      let result;
      try {
        const svc = ctx.api.useCapability(TOKEN);
        result = 'RESOLVED:' + (svc && svc.value);
      } catch (e) {
        result = 'THREW:' + (e && e.name);
      }
      // 用失败信息携带观测结果，供测试读取健康报告。
      throw new Error('CAP_RESULT=' + result);
    },
  };
}
`;

describe('integration · capability-boundary', () => {
  let tmp: TmpPluginsDir | undefined;

  afterEach(async () => {
    await tmp?.cleanup();
    tmp = undefined;
  });

  it('未授权插件解析他人导出服务 → CapabilityDeniedError（不静默）', async () => {
    tmp = await createTmpPluginsDir();
    await tmp.writePlugin(
      { id: 'com.qa.provider', requires: [CAP] },
      PROVIDER_SOURCE,
      'index.js',
    );
    // consumer 声明硬依赖（provider 先启动）但**不**声明 command.provide → 未授权。
    await tmp.writePlugin(
      { id: 'com.qa.consumer', dependencies: { 'com.qa.provider': '^1.0.0' } },
      CONSUMER_SOURCE,
      'index.js',
    );

    const kernel = new Kernel({ roots: [tmp.root] });
    const result = await kernel.start();
    const report = await kernel.health();
    const consumer = report.plugins.find((p) => p.id === 'com.qa.consumer');

    expect(result.started).toContain('com.qa.provider');
    expect(result.failed).toContain('com.qa.consumer');
    expect(kernel.pluginRegistry.getLoaded('com.qa.consumer')!.state).toBe(
      'Failed',
    );
    expect(consumer?.message).toContain('THREW:CapabilityDeniedError');

    await kernel.shutdown();
  });

  it('已授权插件解析他人导出服务 → 成功解析（跨插件能力消费）', async () => {
    tmp = await createTmpPluginsDir();
    await tmp.writePlugin(
      { id: 'com.qa.provider', requires: [CAP] },
      PROVIDER_SOURCE,
      'index.js',
    );
    // consumer 声明 command.provide + trusted 内核 → 授予。
    await tmp.writePlugin(
      {
        id: 'com.qa.consumer',
        dependencies: { 'com.qa.provider': '^1.0.0' },
        requires: [CAP],
      },
      CONSUMER_SOURCE,
      'index.js',
    );

    const kernel = new Kernel({ roots: [tmp.root], trustLevel: 'trusted' });
    const result = await kernel.start();
    const report = await kernel.health();
    const consumer = report.plugins.find((p) => p.id === 'com.qa.consumer');

    expect(result.started).toContain('com.qa.provider');
    // 授权后应解析成功；若失败，message 会显示具体异常（NoProviderError 等）。
    expect(consumer?.message).toContain('RESOLVED:42');

    await kernel.shutdown();
  });
});
