/**
 * 服务注册表 / DI 契约（纯类型）。
 *
 * 令牌相关类型统一由 `service-token.ts` 定义，本文件不再重复声明（docs/06 §1.1 #29 合并）。
 */

import type {
  ServiceToken,
  ServiceFactory,
  Lifetime,
} from './service-token.js';

export type {
  ServiceToken,
  ServiceFactory,
  Lifetime,
  ServiceDescriptor,
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

/** 插件可见的服务视图：与 ServiceRegistry 同形；独立命名以免暗示「插件能拿到内核注册表」。 */
export type ServicesView = ServiceRegistry;
