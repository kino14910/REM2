/**
 * theme-dark 插件 —— UI / 主题是插件（docs/02 §M.5，动机 #1）。
 *
 * 注册一套深色主题 token；**内核完全不知道"颜色"是什么概念**。
 * UI 外壳插件（如 electron-shell）消费这些 token 来渲染。
 */

import { KernelTokens, ServiceToken } from 'rem2-kernel';
import type {
  EventBus,
  Plugin,
  PluginContext,
  PluginManifest,
  Unsubscribe,
} from 'rem2-kernel';

/** 主题定义（UI 概念，由插件自由定义）。 */
export interface ThemeToken {
  id: string;
  colors: Record<string, string>;
  fonts: Record<string, string>;
  spacing: Record<string, string>;
}

/** 主题注册表契约（由 UI 外壳插件实现；内核只提供 token 传递位）。 */
export interface ThemeRegistry {
  register(theme: ThemeToken): void;
  unregister(themeId: string): void;
  list(): ThemeToken[];
}

/** 主题注册表令牌（UI 外壳插件注册，theme-dark 消费）。 */
export const ThemeRegistryToken = ServiceToken.create<ThemeRegistry>({
  id: 'plugin.ui.theme-registry',
  capability: 'ui.theme',
  describe: '主题注册表',
});

/** 事件总线令牌。 */
const EventBusToken: ServiceToken<EventBus> = ServiceToken.create<EventBus>({
  id: KernelTokens.EventBus.id,
  describe: '内核事件总线',
});

const DARK_THEME: ThemeToken = {
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

/**
 * 插件实现。
 */
export default class ThemeDarkPlugin implements Plugin {
  readonly manifest: PluginManifest = {
    id: 'com.rem2.theme-dark',
    name: 'Dark Theme',
    version: '1.0.0',
    entry: 'src/index.ts',
    optionalDependencies: { 'com.rem2.logger-console': '^1.0.0' },
    capabilities: ['ui.theme'],
    compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
    author: 'rem2-team',
    description: '注册一套深色主题 token',
    tags: ['ui', 'theme'],
  };

  /** 当前主题（未注册到外壳时仅本地持有）。 */
  private theme: ThemeToken | null = null;
  private registry: ThemeRegistry | null = null;
  private readonly unsubs: Unsubscribe[] = [];
  /** 是否有 UI 外壳注册了 ThemeRegistry。 */
  private hasRegistry = false;

  async onConfigure(ctx: PluginContext): Promise<void> {
    this.theme = { ...DARK_THEME };
    void ctx;
  }

  async onStart(ctx: PluginContext): Promise<void> {
    const registry = ctx.services.tryResolve(ThemeRegistryToken);
    if (registry) {
      this.registry = registry;
      registry.register(this.theme!);
      this.hasRegistry = true;
    } else {
      ctx.log.info(
        '未检测到 UI 外壳 ThemeRegistry，主题仅本地注册（degraded）',
      );
    }

    const bus = ctx.services.tryResolve(EventBusToken);
    if (bus) {
      this.unsubs.push(
        bus.on('ui:theme:request', () => {
          void bus.emit('ui:theme:registered', this.theme);
        }),
      );
      await bus.emit('ui:theme:registered', this.theme);
    }

    ctx.log.info(`深色主题已激活（registry=${this.hasRegistry}）`);
  }

  async onStop(ctx: PluginContext, reason: string): Promise<void> {
    if (this.registry && this.theme) {
      this.registry.unregister(this.theme.id);
    }
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.registry = null;
    this.hasRegistry = false;
    ctx.log.info(`深色主题已停用（${reason}）`);
  }

  onHealthCheck(): 'healthy' | 'degraded' {
    return this.hasRegistry ? 'healthy' : 'degraded';
  }

  /** 当前主题（测试用）。 */
  getTheme(): ThemeToken | null {
    return this.theme;
  }
}
