/**
 * `definePlugin()`：唯一插件形态入口（docs/03 §3.1）。
 *
 * 裁决理由（简版）：工厂函数是唯一同时满足
 * ① tree-shaking 友好（setup 是闭包）、② loader 只需 10 行断言、③ 与 esbuild ESM 对齐
 * 的形态。class / 已实例化单例 / 命名导出都各有硬伤（详见 docs/03 §3.1）。
 */

import type { PluginManifestInit } from './contracts/manifest.js';
import type { PluginContext } from './contracts/context.js';
import type { PluginFactory, PluginFactoryHooks } from './contracts/plugin.js';
import { ManifestError } from './errors.js';

/**
 * 声明一个插件。
 *
 * @param manifest 插件内联清单（`entry` 的权威来源是 `plugin.json`，可省略）。
 * @param setup    钩子工厂：内核在 import 后调用它并传入 `PluginContext`。
 */
export function definePlugin(
  manifest: PluginManifestInit,
  setup: (ctx: PluginContext) => PluginFactoryHooks,
): PluginFactory {
  if (!manifest || typeof manifest.id !== 'string' || manifest.id.trim() === '') {
    throw new ManifestError(['definePlugin 的 manifest.id 必须是非空字符串']);
  }
  if (typeof setup !== 'function') {
    throw new TypeError(`插件 ${manifest.id} 的 setup 必须是函数`);
  }

  const factory = function rem2Plugin(ctx: PluginContext): PluginFactoryHooks {
    return setup(ctx);
  } as PluginFactory;

  // 内联清单挂在工厂上：loader 用它做「与 plugin.json 是否漂移」的判定，
  // 避免为了取 id 而要求插件额外导出一个具名成员。
  //
  // 顺序要紧：先 defineProperty 再 freeze。反过来（先 freeze 后挂属性）会抛
  // "Cannot define property manifest, object is not extensible" ——
  // 而这个错误只在内核真正加载插件时才出现，编写插件时完全看不到。
  Object.defineProperty(factory, 'manifest', {
    value: Object.freeze({ ...manifest }),
    enumerable: true,
  });

  return Object.freeze(factory) as PluginFactory;
}
