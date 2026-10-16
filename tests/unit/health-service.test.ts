/**
 * 健康服务单测。
 *
 * 自检函数不再经 `registerCheck` 旁路注册，而是经 `health.check` **扩展点** 贡献
 * （docs/06 §1.2 #57）—— 这是 P3 的直接后果。
 */

import { describe, expect, it } from 'vitest';
import { HealthService } from '../../src/kernel/observability/health-service.js';
import { PluginsRegistry } from '../../src/kernel/registry/plugins-registry.js';
import { ExtensionPointRegistry } from '../../src/kernel/extensions/registry.js';
import { EXTENSION_POINT_DEFS } from '../../src/kernel/extensions/definitions.js';
import type { LoadedPlugin } from '../../src/kernel/extensions/ports-types.js';
import type { PluginStateT } from '../../src/kernel/contracts/plugins.js';
import { makeManifest } from '../helpers/make-manifest.js';

function fakeLoaded(id: string, state: PluginStateT): LoadedPlugin {
  return {
    manifest: makeManifest({ id }),
    hooks: {},
    context: {} as never,
    container: {} as never,
    state,
    health: { status: 'healthy' },
    rootDir: `/x/${id}`,
    permissions: { pluginId: id, granted: [], denied: [], isGranted: () => true },
  };
}

/** 造一套「空注册表 + 已定义扩展点」的组合。 */
function fixture(): { registry: PluginsRegistry; extensions: ExtensionPointRegistry } {
  const registry = new PluginsRegistry();
  const extensions = new ExtensionPointRegistry();
  extensions.defineAll(EXTENSION_POINT_DEFS);
  return { registry, extensions };
}

describe('health-service · 报告聚合', () => {
  it('全部 Active → healthy', async () => {
    const { registry, extensions } = fixture();
    registry.add(fakeLoaded('a', 'Active'));
    registry.add(fakeLoaded('b', 'Active'));
    const svc = new HealthService('1.0.0', registry, extensions);

    const report = await svc.report();
    expect(report.status).toBe('healthy');
    expect(report.plugins.length).toBe(2);
    expect(report.kernel.version).toBe('1.0.0');
  });

  it('存在 Failed → unhealthy', async () => {
    const { registry, extensions } = fixture();
    registry.add(fakeLoaded('a', 'Active'));
    registry.add(fakeLoaded('b', 'Failed'));
    const svc = new HealthService('1.0.0', registry, extensions);
    expect((await svc.report()).status).toBe('unhealthy');
  });

  it('存在 Degraded → degraded', async () => {
    const { registry, extensions } = fixture();
    registry.add(fakeLoaded('a', 'Active'));
    registry.add(fakeLoaded('b', 'Degraded'));
    const svc = new HealthService('1.0.0', registry, extensions);
    expect((await svc.report()).status).toBe('degraded');
  });

  it('经 health.check 扩展点贡献的自检函数被调用', async () => {
    const { registry, extensions } = fixture();
    registry.add(fakeLoaded('a', 'Active'));
    const svc = new HealthService('1.0.0', registry, extensions);
    extensions.contribute('a', 'health.check', {
      contributionId: 'a',
      impl: () => 'degraded',
    });

    const report = await svc.report();
    expect(report.status).toBe('degraded');
    expect(report.plugins[0]!.status).toBe('degraded');
  });

  it('自检抛错 → unhealthy', async () => {
    const { registry, extensions } = fixture();
    registry.add(fakeLoaded('a', 'Active'));
    const svc = new HealthService('1.0.0', registry, extensions);
    extensions.contribute('a', 'health.check', {
      contributionId: 'a',
      impl: () => {
        throw new Error('check failed');
      },
    });

    const report = await svc.report();
    expect(report.status).toBe('unhealthy');
    expect(report.plugins[0]!.message).toMatch(/check failed/);
  });

  it('retractAll 后回落到状态映射（P6 强制回收）', async () => {
    const { registry, extensions } = fixture();
    registry.add(fakeLoaded('a', 'Active'));
    const svc = new HealthService('1.0.0', registry, extensions);
    extensions.contribute('a', 'health.check', {
      contributionId: 'a',
      impl: () => 'unhealthy',
    });
    extensions.retractAll('a');

    const report = await svc.report();
    expect(report.status).toBe('healthy');
  });
});
