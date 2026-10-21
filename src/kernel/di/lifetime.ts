export enum Lifetime {
  Singleton = 'singleton',
  Transient = 'transient',
  /** Singleton within the current scope container. */
  Scoped = 'scoped',
}

/** String form to enum (unrecognized values default to Singleton). */
export function normalizeLifetime(value?: Lifetime | string): Lifetime {
  if (value === Lifetime.Transient || value === 'transient') {
    return Lifetime.Transient
  }
  if (value === Lifetime.Scoped || value === 'scoped') {
    return Lifetime.Scoped
  }
  return Lifetime.Singleton
}
