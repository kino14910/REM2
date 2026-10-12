/**
 * 前端 DTO：与内核契约的**投影**（docs/12 §5.3）。
 *
 * 为什么要有 DTO 而不是直接用内核类型：内核的 `PluginInfo` / `LoadedPlugin` /
 * `HealthReport` 含 container、permissions、绝对路径等内部字段。DTO 是显式的
 * 「只投影必要字段」白名单 —— 未来内核加字段不会自动泄漏到 renderer。
 *
 * 每个类型上面的注释标注它对应的 kernel 契约路径，便于人工对齐。
 */

/** 面板 DTO ← `kernel/contracts/ui.ts` 的 `PanelContribution`。 */
export interface PanelDto {
  panelId: string;
  title: string;
  icon: string;
  region: 'main' | 'side';
  /** 排序权重，升序。 */
  order: number;
  /** 提供该面板数据的命令名。 */
  command: string;
}

/** 路由 DTO ← `kernel/contracts/ui.ts` 的 `RouteContribution`。 */
export interface RouteDto {
  path: string;
  title: string;
  panelId: string;
  commandPrefix: string;
  order: number;
}

/** 主题 DTO ← `kernel/contracts/ui.ts` 的 `ThemeDefinition`。 */
export interface ThemeDto {
  id: string;
  colors: Record<string, string>;
  fonts: Record<string, string>;
  spacing: Record<string, string>;
}

/** 健康 DTO ← `kernel/contracts/health.ts` 的 `HealthReport`（裁剪版）。 */
export interface HealthDto {
  status: 'healthy' | 'degraded' | 'unhealthy';
  plugins: Array<{
    id: string;
    state: string;
    status: 'healthy' | 'degraded' | 'unhealthy';
    message?: string;
  }>;
}

/**
 * 命令结果 DTO（前端与主进程之间的统一形状）。
 *
 * ★ 字段名必须与命令插件的**实际返回**对齐：IpcBridge 的 `reply({ok, result})`
 * 把插件的返回值原样装进 `result`，preload 又解出 `payload.result`，
 * 所以前端 `invoke` 拿到的就是插件的原始返回对象本身。
 * 曾把这里写成 `{ok, result, error}`，而插件返回的是 `{ok, output}` ——
 * `res.result` 恒为 undefined，UI 只能显示 "ok"，且**不报任何错**。
 */
export interface CommandResultDto {
  command: string;
  ok: boolean;
  output?: string;
  error?: string;
}

/** 插件状态变化事件 DTO。 */
export interface PluginStateChangedDto {
  pluginId: string;
  /** 逻辑状态机取值（`kernel/contracts/plugins.ts` 的 `PluginStateT`）。 */
  state: string;
}
