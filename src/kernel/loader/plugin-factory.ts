/**
 * 插件工厂断言：90 行猜测逻辑 → ~10 行断言（docs/09 O22）。
 *
 * 唯一形态 = `export default definePlugin(manifest, setup)`，即 `mod.default` 是函数。
 * 旧的 4 种猜测（class / 实例 / 命名导出 / 双层 default）全部移除 ——
 * 每多一种形态，就多一处「dev 能跑 prod 炸」的结构性可能（docs/11 P4）。
 */

import type { PluginFactory } from '../contracts/plugin.js';
import type { PluginManifestInit } from '../contracts/manifest.js';

/** 工厂函数上由 `definePlugin` 挂载的内联清单。 */
export type PluginFactoryWithManifest = PluginFactory & {
  readonly manifest: PluginManifestInit;
};

/** 断言动态 import 的模块导出唯一形态的工厂函数。 */
export function assertPluginFactory(
  moduleExports: unknown,
  pluginId: string,
): PluginFactoryWithManifest {
  const mod = moduleExports as { default?: unknown } | null;
  const candidate = mod?.default;

  if (typeof candidate !== 'function') {
    throw new TypeError(
      `插件 ${pluginId} 必须 export default definePlugin(manifest, setup)（default 必须是函数，实际为 ${
        candidate === undefined ? 'undefined' : typeof candidate
      }）`,
    );
  }

  return candidate as PluginFactoryWithManifest;
}

/** 读取工厂携带的内联清单 id（用于与 `plugin.json` 做漂移检测）。 */
export function inlineManifestId(
  factory: PluginFactoryWithManifest,
): string | undefined {
  const manifest = factory.manifest;
  return manifest && typeof manifest.id === 'string' ? manifest.id : undefined;
}
