/**
 * 服务注册表门面（见 docs/01）。
 *
 * `ServiceRegistry` 是 Container 的窄接口视图。插件拿到的是被裁剪过的注册表，
 * 其 `resolve` 会经过能力代理（由 CapabilityGuard 包装，见 §J.4）。
 */

import type {
  ServiceToken,
  ServiceFactory,
  Lifetime,
} from '../contracts/service-token.js';
import type { Container } from '../contracts/container.js';
import type { ServiceRegistry } from '../contracts/service.js';

/** 注册表门面（组合一个容器）。 */
export class ServiceRegistryFacade implements ServiceRegistry {
  constructor(private readonly container: Container) {}

  register<T>(
    token: ServiceToken<T>,
    factory: ServiceFactory<T>,
    lifetime?: Lifetime,
  ): this {
    this.container.register(token, factory, lifetime);
    return this;
  }

  registerInstance<T>(token: ServiceToken<T>, instance: T): this {
    this.container.registerInstance(token, instance);
    return this;
  }

  resolve<T>(token: ServiceToken<T>): T {
    return this.container.resolve(token);
  }

  tryResolve<T>(token: ServiceToken<T>): T | undefined {
    return this.container.tryResolve(token);
  }

  has(token: ServiceToken<unknown>): boolean {
    return this.container.has(token);
  }

  list(): string[] {
    return this.container.list();
  }
}
