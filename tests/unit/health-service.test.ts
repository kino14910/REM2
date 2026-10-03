/**
 * 健康服务单测（docs/02 §I.4）。
 */

import { describe, expect, it } from 'vitest';
import { HealthService } from '../../src/kernel/observability/health-service.js';
import { PluginsRegistry } from '../../src/kernel/registry/plugins-registry.js';
import { PluginState, type LoadedPlugin } from '../../src/kernel/types.js';
import { makeManifest } from '../helpers/make-manifest.js';

function fakeLoaded(id: string, state: PluginState): LoadedPlugin {
  return {
    manifest: makeManifest({ id }),
    instance: { manifest: makeManifest({ id }) } as never,
    context: {} as never,
    container: {} as never,
    state,
    health: { status: 'healthy' },
    rootDir: `/x/${id}`,
    permissions: {
      pluginId: id,
      granted: [],
      denied: [],
      isGranted: () => true,
    },
  };
}

describe('health-service · 报告聚合', () => {
  it('全部 Started → healthy', async () => {
    const registry = new PluginsRegistry();
    registry.add(fakeLoaded('a', PluginState.Started));
    registry.add(fakeLoaded('b', PluginState.Started));
    const svc = new HealthService('1.0.0', registry);

    const report = await svc.report();
    expect(report.status).toBe('healthy');
    expect(report.plugins.length).toBe(2);
    expect(report.kernel.version).toBe('1.0.0');
  });

  it('存在 Failed → unhealthy', async () => {
    const registry = new PluginsRegistry();
    registry.add(fakeLoaded('a', PluginState.Started));
    registry.add(fakeLoaded('b', PluginState.Failed));
    const svc = new HealthService('1.0.0', registry);

    const report = await svc.report();
    expect(report.status).toBe('unhealthy');
  });

  it('存在 Degraded → degraded', async () => {
    const registry = new PluginsRegistry();
    registry.add(fakeLoaded('a', PluginState.Started));
    registry.add(fakeLoaded('b', PluginState.Degraded));
    const svc = new HealthService('1.0.0', registry);

    const report = await svc.report();
    expect(report.status).toBe('degraded');
  });

  it('注册的自检函数被调用', async () => {
    const registry = new PluginsRegistry();
    registry.add(fakeLoaded('a', PluginState.Started));
    const svc = new HealthService('1.0.0', registry);
    svc.registerCheck('a', () => 'degraded');

    const report = await svc.report();
    expect(report.status).toBe('degraded');
    expect(report.plugins[0]!.status).toBe('degraded');
  });

  it('自检抛错 → unhealthy', async () => {
    const registry = new PluginsRegistry();
    registry.add(fakeLoaded('a', PluginState.Started));
    const svc = new HealthService('1.0.0', registry);
    svc.registerCheck('a', () => {
      throw new Error('check failed');
    });

    const report = await svc.report();
    expect(report.status).toBe('unhealthy');
    expect(report.plugins[0]!.message).toMatch(/check failed/);
  });

  it('注销自检后回落到状态映射', async () => {
    const registry = new PluginsRegistry();
    registry.add(fakeLoaded('a', PluginState.Started));
    const svc = new HealthService('1.0.0', registry);
    svc.registerCheck('a', () => 'unhealthy');
    svc.unregisterCheck('a');

    const report = await svc.report();
    expect(report.status).toBe('healthy');
  });
});
