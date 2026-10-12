/**
 * 插件清单 / 元数据契约（纯类型，零运行时）。
 *
 * 关键变更（docs/13 C2 / C3）：
 * - `entry` **只能是构建产物**（`.js` / `.mjs`），dev 与 prod 同值 → 消除双形态。
 * - 原 `capabilities` 语义含混，拆为：`contributes`（我提供什么）+ `requires`（我需要什么）。
 */

/** 兼容性约束。 */
export interface Compatibility {
  /** 最小内核版本（semver range），如 "^1.0.0"。 */
  minKernel: string;
  /** 可选：最大内核版本（含），用于阻断不兼容大版本。 */
  maxKernel?: string;
  /** 契约版本，如 "1"；major 不同即不兼容。 */
  contractVersion: string;
}

/** 扩展点贡献声明（manifest 侧，静态）。 */
export interface ManifestContribution {
  /** 扩展点 id（必须是 `ExtensionPointId` 的成员）。 */
  point: string;
  /** 槽内唯一 id。 */
  id: string;
  /** 贡献该扩展点所需的能力；缺省取扩展点定义上的 capability。 */
  capability?: string;
}

/** 插件清单。 */
export interface PluginManifest {
  /** 唯一 ID，建议 reverse-DNS：com.example.hello-command。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 插件自身版本（semver）。 */
  version: string;
  /**
   * 入口（相对 rootDir）。**只能是构建产物**：以 `.js` / `.mjs` 结尾。
   * 校验在注册阶段由 `manifest-validator` 完成，loader 不再补全 `.ts`。
   */
  entry: string;

  /** 硬依赖：pluginId -> semver range。缺失/不满足 → 该插件失败。 */
  dependencies?: Record<string, string>;
  /** 软依赖：缺失时插件进入 degraded，其余功能仍可运行。 */
  optionalDependencies?: Record<string, string>;

  /** 我提供什么：静态声明的扩展点贡献。 */
  contributes?: ManifestContribution[];

  /** 我需要什么：能力声明（`PermissionManager.check` 的输入）。 */
  requires?: string[];

  /** 兼容性约束。 */
  compatibility: Compatibility;

  author?: string;
  description?: string;
  icon?: string;
  tags?: string[];
  homepage?: string;

  /**
   * 隔离策略：
   * - 'in-process'（默认）：与内核同进程，性能最高，信任要求最高。
   * - 'worker'：在独立的 Node Worker 线程中运行，内核通过 RPC 驱动生命周期；
   *   崩溃/死循环不阻塞内核主线程，但跨线程通信有序列化开销。
   */
  isolation?: 'in-process' | 'worker';

  /** 插件级自定义配置 schema（内核不解释，透传给插件）。 */
  configSchema?: Record<string, unknown>;
}

/**
 * `definePlugin` 首参可省的字段。
 *
 * `entry` 的权威来源是 `plugin.json`（内核以磁盘清单为唯一事实来源），
 * 因此内联 manifest 无需重复声明；`compatibility` 同理，由 loader 校验 id 一致即可。
 */
export type PluginManifestInit = Omit<
  PluginManifest,
  'entry' | 'compatibility'
> & {
  entry?: string;
  compatibility?: Compatibility;
};
