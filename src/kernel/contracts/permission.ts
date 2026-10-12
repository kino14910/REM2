/**
 * 权限与能力契约（纯类型）。
 *
 * 三段式模型：manifest `requires` 声明 → PermissionManager 授权 → CapabilityGuard 拦截。
 * 扩展点贡献同样受能力校验（docs/13 C7）——未授权的扩展点贡献 → Failed 而非静默。
 */

/** 能力名（分级命名，如 'log.sink' / 'ui.panel' / 'kernel.internals'）。 */
export type Capability = string;

/** 信任级别。 */
export type TrustLevel = 'trusted' | 'sandboxed';

/** 授权判定结果。 */
export interface PermissionDecision {
  granted: string[];
  denied: string[];
  warnings: Array<{ capability: string; reason: string }>;
}

/** 某插件的权限集。 */
export interface PermissionSet {
  readonly pluginId: string;
  readonly granted: readonly string[];
  readonly denied: readonly string[];
  /** 判断某个能力是否已授予。 */
  isGranted(capability: string): boolean;
}

/** 信任策略：定义各级别的默认授予与需告警的能力。 */
export interface TrustPolicy {
  /** 各信任级别默认授予的能力（支持前缀通配，如 'log.*'）。 */
  defaults: Record<TrustLevel, string[]>;
  /** 授予时需要向用户告警的能力前缀。 */
  warnOn: Record<TrustLevel, string[]>;
}

/**
 * 内核承认的能力常量。
 *
 * 能力名散落字符串会导致「拼错即静默失效」（`PermissionManager` 只在 warnOn/defaults 里查），
 * 故收敛为常量。新增能力必须同时更新 `security/trust-policy.ts` 的 defaults/warnOn。
 */
export const Capabilities = {
  /** 贡献日志落地实现。 */
  LogSink: 'log.sink',
  /** 贡献指标导出实现。 */
  MetricsSink: 'metrics.sink',
  /** 贡献 span 导出实现。 */
  TraceExporter: 'trace.exporter',
  /** 贡献配置层。 */
  ConfigProvider: 'config.provide',
  /** 提供业务命令。 */
  CommandProvide: 'command.provide',
  /** 暴露健康自检。 */
  HealthExpose: 'health.expose',
  /** 贡献主题定义。 */
  UiTheme: 'ui.theme',
  /** 贡献声明式面板。 */
  UiPanel: 'ui.panel',
  /** 贡献声明式路由。 */
  UiRoute: 'ui.route',
  /** 替换内核调度器 / 解析器 / 加载器等内部件。 */
  KernelInternals: 'kernel.internals',
  /** 配置写路径。 */
  ConfigAdmin: 'kernel.config.admin',
  /** 权限管理写路径。 */
  PermissionsAdmin: 'kernel.permissions.admin',
  /** 文件读。 */
  FsRead: 'fs.read',
  /** 监听端口。 */
  NetListen: 'net.listen',
} as const;
