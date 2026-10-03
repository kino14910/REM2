/**
 * 测试辅助：断言插件符合契约（impl 可独立于内核验证，见 docs/02 §K.3）。
 */

import { expect } from 'vitest';
import type { Plugin } from 'rem2-kernel';

/**
 * 断言某对象满足 Plugin 契约的最低要求：
 * - 具备 manifest，且 manifest.id/name/version/entry/compatibility 齐备；
 * - 至少实现一个可选钩子；
 * - manifest 与实测 id 一致。
 */
export function assertPluginContract(
  plugin: Plugin,
  expectedId?: string,
): void {
  expect(plugin).toBeDefined();
  expect(typeof plugin).toBe('object');
  expect(plugin.manifest).toBeDefined();
  expect(typeof plugin.manifest.id).toBe('string');
  expect(plugin.manifest.id.length).toBeGreaterThan(0);
  expect(typeof plugin.manifest.name).toBe('string');
  expect(plugin.manifest.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(typeof plugin.manifest.entry).toBe('string');
  expect(plugin.manifest.compatibility).toBeDefined();
  expect(typeof plugin.manifest.compatibility.contractVersion).toBe('string');
  expect(typeof plugin.manifest.compatibility.minKernel).toBe('string');

  if (expectedId !== undefined) {
    expect(plugin.manifest.id).toBe(expectedId);
  }

  const hooks = [
    'onDiscover',
    'onLoad',
    'onConfigure',
    'onStart',
    'onStop',
    'onUnload',
    'onDispose',
    'onHealthCheck',
  ] as const;
  const implemented = hooks.filter(
    (h) =>
      typeof (plugin as unknown as Record<string, unknown>)[h] === 'function',
  );
  expect(implemented.length).toBeGreaterThan(0);
}

/** 列出插件实现的钩子。 */
export function implementedHooks(plugin: Plugin): string[] {
  const hooks = [
    'onDiscover',
    'onLoad',
    'onConfigure',
    'onStart',
    'onStop',
    'onUnload',
    'onDispose',
    'onHealthCheck',
  ];
  return hooks.filter(
    (h) =>
      typeof (plugin as unknown as Record<string, unknown>)[h] === 'function',
  );
}
