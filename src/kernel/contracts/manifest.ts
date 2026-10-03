/**
 * 插件清单 / 元数据契约（纯类型，零运行时）。
 * 见 docs/02 §C.2。
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

/**
 * 插件清单。
 *
 * `capabilities` 是能力声明（动机 #7）；`dependencies` 是硬依赖；
 * `optionalDependencies` 是软依赖（能力增强建议，非加载顺序约束，见 docs/02 §D.6）。
 */
export interface PluginManifest {
  /** 唯一 ID，建议 reverse-DNS：com.example.hello-command。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 插件自身版本（semver）。 */
  version: string;
  /** 入口（相对 rootDir 的路径 或 Node 包名）。 */
  entry: string;

  /** 硬依赖：pluginId -> semver range。缺失/不满足 → 该插件失败。 */
  dependencies?: Record<string, string>;
  /** 软依赖：缺失时插件进入 degraded，其余功能仍可运行。 */
  optionalDependencies?: Record<string, string>;

  /** 能力声明（动机 #7）：如 ["log.sink", "config.provider", "fs.read"]。 */
  capabilities?: string[];

  /** 兼容性约束。 */
  compatibility: Compatibility;

  author?: string;
  description?: string;
  icon?: string;
  tags?: string[];
  homepage?: string;

  /**
   * 隔离策略（docs/02 §C.6）：
   * - 'in-process'（默认）：与内核同进程，性能最高，信任要求最高。
   * - 'worker'：在独立的 Node Worker 线程中运行，内核通过 RPC 驱动生命周期；
   *   崩溃/死循环不阻塞内核主线程，但跨线程通信有序列化开销。
   */
  isolation?: 'in-process' | 'worker';

  /** 插件级自定义配置 schema（内核不解释，透传给插件）。 */
  configSchema?: Record<string, unknown>;
}
