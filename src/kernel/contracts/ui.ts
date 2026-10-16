/**
 * UI 扩展点契约（从 `plugins/theme-dark` 上移，docs/03 §7.1 / C15）。
 *
 * 上移的理由：主题/面板/路由是**内核契约**而非某个插件的私有类型 ——
 * 宿主与插件两侧都只依赖 `kernel/contracts/ui.js`，从而消除外壳 import 插件源码的越界（X1）。
 *
 * 形态裁决：`ui.panel` / `ui.route` 是**声明式描述**，插件不提供 Svelte 组件，
 * 由前端 `PanelHost.svelte` / `RouteHost.svelte` 渲染 chrome。
 */

/** 主题定义（token 集合）。 */
export interface ThemeDefinition {
  readonly id: string;
  readonly colors: Readonly<Record<string, string>>;
  readonly fonts: Readonly<Record<string, string>>;
  readonly spacing: Readonly<Record<string, string>>;
}

/** 主题注册表（宿主提供，作为 `ui.theme` 的宿主默认实现）。 */
export interface ThemeRegistry {
  register(theme: ThemeDefinition): void;
  unregister(themeId: string): void;
  list(): ThemeDefinition[];
  get(themeId: string): ThemeDefinition | undefined;
  /** 切换当前激活主题。 */
  activate(themeId: string): boolean;
  /** 当前激活主题 id（未激活时为 undefined）。 */
  active(): string | undefined;
}

/** 面板布局区域。 */
export type PanelRegion = 'main' | 'side';

/**
 * 声明式面板描述。
 *
 * `command` 是**数据来源**：前端请求某面板数据时，主进程按该命令走事件总线，
 * 由插件自己决定返回什么形状（内核不校验，见 docs/04 §10 R2）。
 */
export interface PanelContribution {
  readonly panelId: string;
  readonly title: string;
  readonly icon: string;
  readonly region: PanelRegion;
  /** 排序权重，升序。 */
  readonly order: number;
  /** 提供该面板数据的命令名（经事件总线 `bus.request`）。 */
  readonly command: string;
}

/** 声明式路由。 */
export interface RouteContribution {
  readonly path: string;
  readonly title: string;
  /** 关联的面板 id（前端据此切换主区内容）。 */
  readonly panelId: string;
  /** 命令前缀（该路由下允许的命令名前缀）。 */
  readonly commandPrefix: string;
  readonly order: number;
}
