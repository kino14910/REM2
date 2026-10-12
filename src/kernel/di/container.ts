/**
 * DI 容器（docs/02 §F.1 / §E.3）。
 *
 * 关键不变量：
 * 1. `parent` 为私有字段，插件无法通过公开 API 拿到父容器句柄（越界访问防护，动机 #7）。
 *    仅暴露 `hasParent: boolean`。
 * 2. 父容器服务默认**不可**被子容器解析；父容器通过 `markExported(token)`（或
 *    `shareable: true`）声明"公共/可共享"服务后，子容器才能解析。
 * 3. singleton/scoped 缓存实例并在 dispose 时调用 `dispose()`（若实现）。
 * 4. 解析服务时做循环检测（构造栈），抛 CircularDependencyError。
 */

import type { Container as ContainerContract } from '../contracts/container.js';
import type { ServiceToken, ServiceFactory } from '../contracts/service-token.js';
import { Lifetime, normalizeLifetime } from './lifetime.js';
import { CircularDependencyError, NoProviderError } from '../errors.js';
import type { ServiceRegistry } from '../contracts/service.js';

interface Registration<T = unknown> {
  token: ServiceToken<T>;
  factory: ServiceFactory<T> | null;
  instance: T | undefined;
  hasInstance: boolean;
  lifetime: Lifetime;
}

/** 可被容器处置的对象。 */
interface Disposable {
  dispose(): void;
}

function isDisposable(value: unknown): value is Disposable {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).dispose === 'function'
  );
}

/**
 * rem2 DI 容器。
 */

/** 容器构造选项。 */
export interface ContainerOptions {
  scope: string;
  parent?: Container;
  /** 本容器的服务是否默认对子容器可见（内核 root 容器通常为 true）。 */
  shareable?: boolean;
  /** 是否以"插件作用域"运行（插件容器：不自动向父容器导出、且父服务需显式导出才可见）。 */
  pluginScope?: boolean;
}

/**
 * 父容器引用表（模块私有）。
 *
 * 为什么用 `WeakMap` 而不是 `private parentContainer` 字段：
 * TS 的 `private` 只是编译期约束，运行期该字段仍是**可枚举、可读写**的普通属性，
 * 插件可以 `(ctx.container as any).parentContainer` 拿到 root 容器，
 * 进而解析任意内核服务或其他插件导出的服务 —— **完全绕过 CapabilityGuard**。
 * 把父引用放进模块私有 WeakMap 后，容器实例上不存在任何指向父容器的属性或方法，
 * 插件在运行期无法取得父引用；而 `resolve()` 仍可在内部完成向上委派。
 */
const PARENTS = new WeakMap<Container, Container>();

/** 模块私有：读取容器的父容器（仅容器内部使用，不对外导出）。 */
function parentOf(container: Container): Container | undefined {
  return PARENTS.get(container);
}

/**
 * DI 容器。
 */
export class Container implements ContainerContract, ServiceRegistry {
  readonly scope: string;
  private readonly shareable: boolean;
  private readonly pluginScope: boolean;
  private readonly registrations = new Map<string, Registration>();
  /** 显式导出的服务 id（对子容器可见）。 */
  private readonly exported = new Set<string>();
  /** 已挂载的子容器：本容器解析未命中时下探其导出项（兄弟插件互相消费）。 */
  private readonly mountedChildren = new Map<string, Container>();
  /** 构造栈，用于循环检测。 */
  private readonly resolving: string[] = [];
  private disposed = false;

  constructor(opts: ContainerOptions) {
    this.scope = opts.scope;
    if (opts.parent) PARENTS.set(this, opts.parent);
    this.shareable = opts.shareable ?? false;
    this.pluginScope = opts.pluginScope ?? false;
  }

  /** 是否存在父容器（**只暴露布尔判定，不暴露父引用本身**）。 */
  get hasParent(): boolean {
    return PARENTS.has(this);
  }

  register<T>(
    token: ServiceToken<T>,
    factory: ServiceFactory<T>,
    lifetime: Lifetime | string = Lifetime.Singleton,
  ): this {
    this.assertNotDisposed();
    this.registrations.set(token.id, {
      token,
      factory,
      instance: undefined,
      hasInstance: false,
      lifetime: normalizeLifetime(lifetime),
    });
    return this;
  }

  registerInstance<T>(token: ServiceToken<T>, instance: T): this {
    this.assertNotDisposed();
    this.registrations.set(token.id, {
      token,
      factory: null,
      instance,
      hasInstance: true,
      lifetime: Lifetime.Singleton,
    });
    return this;
  }

  resolve<T>(token: ServiceToken<T>): T {
    this.assertNotDisposed();
    const reg = this.registrations.get(token.id) as Registration<T> | undefined;
    if (reg) {
      return this.instantiate<T>(reg);
    }

    // 兄弟插件：下探已挂载子容器的导出项。
    for (const child of this.mountedChildren.values()) {
      if (child.isExported(token.id)) {
        const found = child.tryResolve<T>(token);
        if (found !== undefined) return found;
      }
    }

    // 向父容器解析：仅当父"可共享"或父显式导出了该 token。
    const parent = parentOf(this);
    if (parent && parent.canBeResolvedByChild(token.id, this.pluginScope)) {
      return parent.resolve<T>(token);
    }

    throw new NoProviderError(token.id);
  }

  tryResolve<T>(token: ServiceToken<T>): T | undefined {
    try {
      return this.resolve(token);
    } catch {
      return undefined;
    }
  }

  has(token: ServiceToken<unknown>): boolean {
    if (this.registrations.has(token.id)) return true;
    const parent = parentOf(this);
    if (parent && parent.canBeResolvedByChild(token.id, this.pluginScope)) {
      return parent.has(token);
    }
    return false;
  }

  /**
   * `list()` 返回本容器可见的服务 id：自身 + 可从父解析到的（导出/共享）服务。
   * 便于测试断言 `list()` 包含自身注册项。
   */
  list(): string[] {
    const own = Array.from(this.registrations.keys());
    const inherited: string[] = [];
    const parent = parentOf(this);
    if (parent) {
      for (const id of parent.visibleIds()) {
        if (parent.canBeResolvedByChild(id, this.pluginScope)) {
          inherited.push(id);
        }
      }
    }
    return Array.from(new Set([...own, ...inherited])).sort();
  }

  createChild(scope: string): Container {
    this.assertNotDisposed();
    return new Container({ scope, parent: this, pluginScope: true });
  }

  /** 标记某 token 为"已导出"（子容器可解析）。 */
  markExported<T>(token: ServiceToken<T>): void {
    this.exported.add(token.id);
  }

  /** 取消导出。 */
  markUnexported<T>(token: ServiceToken<T>): void {
    this.exported.delete(token.id);
  }

  /** 该 token 是否被本容器显式导出。 */
  isExported(id: string): boolean {
    return this.exported.has(id);
  }

  /** 本容器当前是否还有任何已导出服务（供内核决定是否卸载挂载）。 */
  hasExports(): boolean {
    return this.exported.size > 0;
  }

  /** `markExported` 的语义别名（插件 API 使用）。 */
  exportService<T>(token: ServiceToken<T>): void {
    this.markExported(token);
  }

  /** `markUnexported` 的语义别名（插件 API 使用）。 */
  unexportService<T>(token: ServiceToken<T>): void {
    this.markUnexported(token);
  }

  /**
   * 挂载子容器：本容器解析未命中时下探其导出项。
   * 由插件的 `api.export()` 调用，实现"父容器按需解析子容器已导出的服务"。
   */
  mountChildContainer(child: Container): void {
    this.mountedChildren.set(child.scope, child);
  }

  /** 卸载子容器。 */
  unmountChildContainer(child: Container): void {
    this.mountedChildren.delete(child.scope);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const reg of this.registrations.values()) {
      if (reg.hasInstance && isDisposable(reg.instance)) {
        try {
          reg.instance.dispose();
        } catch {
          // dispose 期间忽略单个服务错误，保证其余服务继续释放。
        }
      }
    }
    this.registrations.clear();
    this.exported.clear();
    for (const child of this.mountedChildren.values()) child.dispose();
    this.mountedChildren.clear();
  }

  // ── 内部可见性判定 ──

  /**
   * 本容器是否能"被其子容器"解析某 id。
   *
   * 与 `resolve()` 的查找顺序保持一致，三条路径：
   * 1. 本容器自身注册（需 shareable 或显式 markExported）。
   * 2. **已挂载的子容器导出的服务**（兄弟插件互相消费，动机 #9）。
   *    若漏掉这一条，`resolve()` 里能命中、但可见性判定却先否决，会导致
   *    "服务明明已导出却报 NoProviderError" 的不一致。
   * 3. 向上委托父容器。
   */
  private canBeResolvedByChild(id: string, childPluginScope: boolean): boolean {
    if (this.registrations.has(id)) {
      // 注册项对子可见的条件：
      // - 父容器 shareable（内核 root 通常 true，表示公共设施）→ 全部可见
      // - 或该 token 被显式 markExported
      if (this.shareable) return true;
      if (this.exported.has(id)) return true;
      // 插件作用域容器：父若非 shareable 且未导出 → 不可见
      void childPluginScope;
      return false;
    }

    // 兄弟插件：父容器已挂载的子容器若导出了该 id，则对其余子容器可见。
    for (const child of this.mountedChildren.values()) {
      if (child.isExported(id)) return true;
    }

    // 继续向上查找。
    const parent = parentOf(this);
    if (parent) {
      return parent.canBeResolvedByChild(id, childPluginScope);
    }
    return false;
  }

  /** 本容器自身（含向上层，以及已挂载子容器导出项）可见的全部 id。 */
  private visibleIds(): string[] {
    const own = Array.from(this.registrations.keys());
    const parent = parentOf(this);
    const up = parent ? parent.visibleIds() : [];
    const mounted: string[] = [];
    for (const child of this.mountedChildren.values()) {
      mounted.push(...child.exportedIds());
    }
    return Array.from(new Set([...own, ...up, ...mounted]));
  }

  /** 本容器**显式导出**的服务 id（供父容器聚合可见性）。 */
  private exportedIds(): string[] {
    return Array.from(this.exported);
  }

  private instantiate<T>(reg: Registration<T>): T {
    if (reg.hasInstance) {
      return reg.instance as T;
    }

    const tokenId = reg.token.id;
    if (this.resolving.includes(tokenId)) {
      throw new CircularDependencyError('service', [
        ...this.resolving,
        tokenId,
      ]);
    }

    let value: T;
    if (reg.factory === null) {
      value = reg.instance as T;
    } else {
      this.resolving.push(tokenId);
      try {
        value = reg.factory(this);
      } finally {
        this.resolving.pop();
      }
    }

    if (
      reg.lifetime === Lifetime.Singleton ||
      reg.lifetime === Lifetime.Scoped
    ) {
      reg.instance = value;
      reg.hasInstance = true;
    }
    return value;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error(`容器已销毁：${this.scope}`);
    }
  }
}

/** 别名（内部旧引用兼容）。 */
export { Container as DiContainer };
