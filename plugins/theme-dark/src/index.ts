/**
 * theme-dark 插件 —— UI / 主题是插件。
 *
 * 经 `ui.theme` 扩展点贡献一套深色主题 token（单例槽，`keep-first` 裁决）。
 * **内核完全不知道「颜色」是什么概念**；前端把 token 映射为 CSS 变量。
 */

import { definePlugin } from 'rem2-kernel';
import type { PluginContext, ThemeDefinition } from 'rem2-kernel';

/** 深色主题 token。 */
const DARK_THEME: ThemeDefinition = {
  id: 'dark',
  colors: {
    background: '#0f1115',
    surface: '#161922',
    text: '#e6e6e6',
    textMuted: '#9aa4b2',
    accent: '#4f9cf9',
    border: '#232838',
  },
  fonts: {
    ui: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    mono: '"JetBrains Mono", "Fira Code", monospace',
  },
  spacing: { xs: '4px', sm: '8px', md: '16px', lg: '24px' },
};

export default definePlugin(
  { id: 'com.rem2.theme-dark', name: 'Dark Theme', version: '1.0.0' },
  (ctx: PluginContext) => {
    let contributed = false;

    return {
      async onStart(): Promise<void> {
        // 唯一的贡献入口：`ui.theme` 单例槽。
        // 若已有主题生效（keep-first），本次贡献被拒并由内核记入 issue，不抛错。
        ctx.extensions.contribute<ThemeDefinition>('ui.theme', {
          contributionId: 'dark',
          impl: DARK_THEME,
        });
        contributed = true;
        ctx.log.info('深色主题已贡献（ui.theme 扩展点）');
      },

      async onStop(hookCtx: PluginContext, reason: string): Promise<void> {
        // 贡献由内核在卸载时按 pluginId 强制回收（P6）。
        contributed = false;
        hookCtx.log.info(`深色主题已停用（${reason}）`);
      },

      onHealthCheck(): 'healthy' | 'degraded' {
        return contributed ? 'healthy' : 'degraded';
      },

      /** 当前主题（测试用）。 */
      getTheme(): ThemeDefinition | null {
        return contributed ? DARK_THEME : null;
      },
    };
  },
);
