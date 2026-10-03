/**
 * 主题注册表实现（UI 外壳侧）。
 *
 * 内核只提供 token 传递位；"主题"这一 UI 概念由外壳/插件定义（docs/02 §M.5）。
 */

import type {
  ThemeRegistry,
  ThemeToken,
} from '../../plugins/theme-dark/src/index.js';

/** 内存主题注册表。 */
export class ThemeRegistryImpl implements ThemeRegistry {
  private readonly themes = new Map<string, ThemeToken>();

  register(theme: ThemeToken): void {
    this.themes.set(theme.id, theme);
  }

  unregister(themeId: string): void {
    this.themes.delete(themeId);
  }

  list(): ThemeToken[] {
    return Array.from(this.themes.values());
  }

  get(themeId: string): ThemeToken | undefined {
    return this.themes.get(themeId);
  }
}
