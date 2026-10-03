/**
 * ServiceToken 与 DI 描述契约（纯类型 + 唯一一个契约级运行时构造器）。
 *
 * 说明：`ServiceToken` 必须在运行期存在（它是容器的键），因此本文件是 contracts
 * 中唯一含运行时导出的模块；`ServiceToken.create` 不引入任何第三方依赖。
 */

/** DI 生命周期。 */
export type Lifetime = 'singleton' | 'transient' | 'scoped';

/** 与 Lifetime 等价的枚举风格类型别名（供偏好枚举语义处使用）。 */
export type LifetimeValue = Lifetime;

/** 服务描述符。 */
export interface ServiceDescriptor<T> {
  /** 唯一标识，如 'kernel.event-bus' / 'plugin.hello.greeter'。 */
  id: string;
  /** 该服务所需能力（用于权限校验）；缺省表示公共能力。 */
  capability?: string;
  /** 供人类阅读的描述。 */
  describe: string;
  /** 仅用于类型推断，运行期不存在。 */
  __type?: T;
}

/** 服务工厂。 */
export type ServiceFactory<T> = (c: unknown) => T;

/**
 * 强类型服务令牌（动机 #5：以 Token 替代全局字符串单例）。
 *
 * 类型参数 `T` 通过 `__type` 幻影字段参与推断；运行期只保留 `id` 与 `descriptor`。
 */
export class ServiceToken<T> {
  readonly id: string;
  readonly descriptor: ServiceDescriptor<T>;

  /** 幻影类型字段，永不读取，仅用于类型系统。 */
  declare private readonly _phantom: T;

  private constructor(descriptor: ServiceDescriptor<T>) {
    this.id = descriptor.id;
    this.descriptor = descriptor;
  }

  /** 创建令牌（唯一构造入口）。 */
  static create<T>(descriptor: ServiceDescriptor<T>): ServiceToken<T> {
    if (!descriptor.id || typeof descriptor.id !== 'string') {
      throw new TypeError('ServiceToken 必须提供非空的 id');
    }
    return new ServiceToken<T>(descriptor);
  }

  toString(): string {
    return `ServiceToken(${this.id})`;
  }
}
