/**
 * DI 生命周期枚举（见 docs/01）。
 */

/** 生命周期语义。 */
export enum Lifetime {
  /** 容器内唯一实例。 */
  Singleton = 'singleton',
  /** 每次 resolve 新建。 */
  Transient = 'transient',
  /** 在当前作用域容器内单例。 */
  Scoped = 'scoped',
}

/** 字符串形式 → 枚举（默认 singleton）。 */
export function normalizeLifetime(value?: Lifetime | string): Lifetime {
  if (value === Lifetime.Transient || value === 'transient') {
    return Lifetime.Transient;
  }
  if (value === Lifetime.Scoped || value === 'scoped') {
    return Lifetime.Scoped;
  }
  return Lifetime.Singleton;
}
