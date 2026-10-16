/**
 * 测试辅助：断言插件钩子集合符合契约。
 *
 * 唯一形态下插件不再有 `instance.manifest`，因此入参是
 * 「`plugin.json` 里的 manifest」+「工厂产出的钩子集合」。
 */

import { expect } from 'vitest';
import type { PluginFactoryHooks, PluginManifest } from 'rem2-kernel';

/**
 * 断言：
 * - manifest 的 id/name/version/entry/compatibility 齐备，且 entry 是构建产物；
 * - 至少实现一个可选钩子。
 */
export function assertPluginContract(
  hooks: PluginFactoryHooks,
  manifest: PluginManifest,
  expectedId?: string,
): void {
  expect(hooks).toBeDefined();
  expect(typeof hooks).toBe('object');
  expect(manifest.id.length).toBeGreaterThan(0);
  expect(typeof manifest.name).toBe('string');
  expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(typeof manifest.entry).toBe('string');
  // 唯一形态：entry 必须是构建产物。
  expect(manifest.entry).toMatch(/\.(js|mjs)$/);
  expect(manifest.compatibility.contractVersion).toBe('string');
  expect(manifest.compatibility.minKernel).toBe('string');

  if (expectedId !== undefined) {
    expect(manifest.id).toBe(expectedId);
  }

  expect(implementedHooks(hooks).length).toBeGreaterThan(0);
}

const HOOK_NAMES = [
  'onDiscover',
  'onLoad',
  'onConfigure',
  'onStart',
  'onStop',
  'onUnload',
  'onDispose',
  'onHealthCheck',
] as const;

/** 列出插件实现的钩子。 */
export function implementedHooks(hooks: PluginFactoryHooks): string[] {
  return HOOK_NAMES.filter(
    (h) => typeof (hooks as unknown as Record<string, unknown>)[h] === 'function',
  );
}
