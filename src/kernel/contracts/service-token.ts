/**
 * 服务令牌与 DI 描述契约（品牌化接口 + 纯函数工厂）。
 *
 * `ServiceToken` 从 class 改为**品牌化 interface**（docs/03 §3.3）：
 * class 形态会在 bundle 里引入原型链与构造器，且 `static create` 依赖模块级状态；
 * 品牌化 interface + `defineToken` 纯函数让任意副本的令牌行为完全一致。
 */

declare const TOKEN_BRAND: unique symbol;

/** DI 生命周期。 */
export type Lifetime = 'singleton' | 'transient' | 'scoped';

/** 与 Lifetime 等价的枚举风格类型别名。 */
export type LifetimeValue = Lifetime;

/** 服务描述符。 */
export interface ServiceDescriptor<T> {
  /** 唯一标识，如 'kernel.event-bus' / 'plugin.hello.greeter'。 */
  id: string;
  /** 供人类阅读的描述。 */
  describe: string;
  /** 该服务所需能力（用于权限校验）；缺省表示公共能力。 */
  capability?: string;
  /** 仅用于类型推断，运行期不存在。 */
  __type?: T;
}

/** 强类型服务令牌：品牌化接口，编译期保证不可被字面量伪造。 */
export interface ServiceToken<T> extends ServiceDescriptor<T> {
  readonly [TOKEN_BRAND]: true;
}

/** 服务工厂。 */
export type ServiceFactory<T> = (c: unknown) => T;

/** 创建服务令牌（唯一构造入口，纯函数、无模块级状态）。 */
export function defineToken<T>(descriptor: ServiceDescriptor<T>): ServiceToken<T> {
  if (!descriptor.id || typeof descriptor.id !== 'string') {
    throw new TypeError('defineToken 必须提供非空的 id');
  }
  return {
    id: descriptor.id,
    describe: descriptor.describe,
    ...(descriptor.capability !== undefined
      ? { capability: descriptor.capability }
      : {}),
  } as ServiceToken<T>;
}
