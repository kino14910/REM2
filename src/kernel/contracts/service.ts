/**
 * 服务注册表 / DI 契约（纯类型）。见 docs/02 §F.1。
 */

import type {
  ServiceToken,
  ServiceFactory,
  Lifetime,
} from './service-token.js';

// 便于消费方（如 contracts/context.ts）从本模块统一取用令牌类型。
export type {
  ServiceToken,
  ServiceFactory,
  Lifetime,
} from './service-token.js';

/**
 * 服务注册表门面。Container 实现本接口。
 */
export interface ServiceRegistry {
  register<T>(
    token: ServiceToken<T>,
    factory: ServiceFactory<T>,
    lifetime?: Lifetime,
  ): this;
  registerInstance<T>(token: ServiceToken<T>, instance: T): this;
  resolve<T>(token: ServiceToken<T>): T;
  tryResolve<T>(token: ServiceToken<T>): T | undefined;
  has(token: ServiceToken<unknown>): boolean;
  list(): string[];
}
