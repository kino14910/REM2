/**
 * 主题注册表实现（宿主侧）。
 *
 * 类型来源已从 `plugins/theme-dark/src/index.js` 改为 `kernel/contracts/ui.js`
 * （docs/06 C15）—— 消除了诊断报告里的 X1 越界：外壳不再 import 插件源码。
 * 两侧现在只依赖内核契约这一个方向。
 */

import type { ThemeDefinition, ThemeRegistry } from '../../kernel/contracts/ui.js';

/** 内存主题注册表（`ui.theme` 单例槽的宿主默认实现所引用的服务）。 */
export class ThemeRegistryImpl implements ThemeRegistry {
  private readonly themes = new Map<string, ThemeDefinition>();
  private activeId: string | undefined;

  register(theme: ThemeDefinition): void {
    this.themes.set(theme.id, theme);
  }

  unregister(themeId: string): void {
    this.themes.delete(themeId);
    if (this.activeId === themeId) this.activeId = undefined;
  }

  list(): ThemeDefinition[] {
    return Array.from(this.themes.values());
  }

  get(themeId: string): ThemeDefinition | undefined {
    return this.themes.get(themeId);
  }

  /** 切换当前主题；未注册的 id 返回 false（不抛错，由调用方回给前端）。 */
  activate(themeId: string): boolean {
    if (!this.themes.has(themeId)) return false;
    this.activeId = themeId;
    return true;
  }

  active(): string | undefined {
    return this.activeId;
  }
}
