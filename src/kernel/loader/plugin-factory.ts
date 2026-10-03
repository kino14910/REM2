/**
 * 插件实例工厂（docs/02 §C：兼容「类」、「实例」、「default 包装」三种导出）。
 */

import type { Plugin, PluginModuleExport } from '../contracts/lifecycle.js';

/**
 * 把动态 import 的模块对象转换为 `Plugin` 实例。
 *
 * 支持：
 * 1. `export default class X implements Plugin {}`      → 实例化
 * 2. `export default new X()`（已实例化）                → 直接使用
 * 3. `export const plugin = new X()`                    → 使用
 * 4. 类构造器（无 default）                              → 实例化
 */
export function instantiatePlugin(
  moduleExports: unknown,
  pluginId: string,
): Plugin {
  const mod = moduleExports as Record<string, unknown>;
  const candidate = pickCandidate(mod, pluginId);

  if (!candidate) {
    throw new TypeError(
      `插件 ${pluginId} 未导出可识别的插件对象（需 default 导出类/实例，或命名导出 plugin）`,
    );
  }

  if (isPluginInstance(candidate)) {
    return candidate;
  }

  if (typeof candidate === 'function') {
    const instance = new (candidate as new () => Plugin)();
    if (!isPluginInstance(instance) && !hasHooks(instance)) {
      throw new TypeError(`插件 ${pluginId} 的构造函数未产出有效 Plugin 实例`);
    }
    return instance;
  }

  throw new TypeError(`插件 ${pluginId} 导出类型无法识别：${typeof candidate}`);
}

function pickCandidate(
  mod: Record<string, unknown>,
  pluginId: string,
): unknown {
  if (mod.default !== undefined) {
    const def = mod.default as PluginModuleExport;
    if (
      typeof def === 'object' &&
      def !== null &&
      'default' in (def as object)
    ) {
      // 双层 default 包装
      return (def as { default: unknown }).default;
    }
    return def;
  }
  if (mod.plugin !== undefined) return mod.plugin;
  if (mod.Plugin !== undefined) return mod.Plugin;
  // 模块本身可能是类（少见）
  void pluginId;
  return undefined;
}

function isPluginInstance(value: unknown): value is Plugin {
  return (
    typeof value === 'object' &&
    value !== null &&
    'manifest' in (value as object) &&
    typeof (value as { manifest: unknown }).manifest === 'object'
  );
}

function hasHooks(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const hooks = [
    'onDiscover',
    'onLoad',
    'onConfigure',
    'onStart',
    'onStop',
    'onUnload',
    'onDispose',
  ];
  return hooks.some(
    (h) => typeof (value as Record<string, unknown>)[h] === 'function',
  );
}
