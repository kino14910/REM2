/**
 * Container 契约（纯类型）。见 docs/01
 *
 * 注意：真正的 Container 实现在 `src/kernel/di/container.ts`；此文件只声明接口，
 * 便于契约层与实现层解耦（contracts 不实现任何逻辑）。
 */

import type { ServiceRegistry } from './service.js';

/**
 * DI 容器契约。
 *
 * 硬性规则（见 docs/01）：
 * 1. 插件容器的 `parent` 对插件不可见（实现类将其设为私有）。
 * 2. 插件注册的服务默认不泄漏到父容器；需显式 `export`。
 */
export interface Container extends ServiceRegistry {
  /** 作用域名，如 'root' / 'plugin:com.rem2.hello-command'。 */
  readonly scope: string;
  /** 是否存在父容器（不暴露父引用本身）。 */
  readonly hasParent: boolean;

  createChild(scope: string): Container;
  dispose(): void;
}
