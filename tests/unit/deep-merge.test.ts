import { describe, expect, it } from 'vitest'

import {
  deepClone,
  deepMerge,
  deepMergeAll,
  getPath,
} from '@/kernel/util/deep-merge.js'

describe('deep-merge · deepMerge', () => {
  it('merges nested plain objects recursively', () => {
    const base = { app: { a: 1, nested: { x: 1, y: 2 } } }

    const merged = deepMerge(base, { app: { nested: { y: 3 } } })

    expect(merged).toEqual({ app: { a: 1, nested: { x: 1, y: 3 } } })
  })

  it('replaces arrays wholesale instead of merging element-wise', () => {
    const merged = deepMerge({ list: [1, 2, 3] }, { list: [9] })

    expect(merged.list).toEqual([9])
  })

  it('replaces primitives and null wholesale', () => {
    expect(deepMerge({ a: 1 }, { a: 2 }).a).toBe(2)
    expect(deepMerge({ a: { b: 1 } }, { a: null }).a).toBeNull()
  })

  it('keeps the base value when the override value is undefined', () => {
    const merged = deepMerge({ a: 1, b: 2 }, { b: undefined })

    expect(merged).toEqual({ a: 1, b: 2 })
  })

  it('does not mutate either input', () => {
    const base = { app: { a: 1 } }
    const override = { app: { b: 2 } }

    deepMerge(base, override)

    expect(base).toEqual({ app: { a: 1 } })
    expect(override).toEqual({ app: { b: 2 } })
  })

  it('gives the merged sub-object its own identity', () => {
    const base = { app: { a: 1 } }
    const override = { app: { b: 2 } }

    const merged = deepMerge(base, override) as {
      app: { a: number; b: number }
    }
    merged.app.a = 99

    expect(base.app.a).toBe(1)
    expect(override.app.b).toBe(2)
  })

  it('replaces a primitive base value with an object override', () => {
    expect(deepMerge({ a: 1 }, { a: { b: 2 } }).a).toEqual({ b: 2 })
  })
})

describe('deep-merge · deepMergeAll', () => {
  it('returns an empty object for an empty layer list', () => {
    expect(deepMergeAll([])).toEqual({})
  })

  it('applies layers left to right, later layers winning', () => {
    expect(deepMergeAll([{ a: 1, b: 1 }, { b: 2 }, { c: 3 }])).toEqual({
      a: 1,
      b: 2,
      c: 3,
    })
  })

  it('tolerates a null layer', () => {
    expect(deepMergeAll([{ a: 1 }, null as never, { b: 2 }])).toEqual({
      a: 1,
      b: 2,
    })
  })
})

describe('deep-merge · getPath', () => {
  const source = { app: { ui: { theme: 'rem' } }, list: [1, 2] }

  it('returns the whole object for an empty path', () => {
    expect(getPath(source, '')).toBe(source)
  })

  it('walks dotted segments', () => {
    expect(getPath(source, 'app.ui.theme')).toBe('rem')
  })

  it('returns undefined for a missing leaf', () => {
    expect(getPath(source, 'app.ui.missing')).toBeUndefined()
  })

  it('returns undefined when an intermediate segment is not an object', () => {
    expect(getPath(source, 'app.ui.theme.deeper')).toBeUndefined()
    expect(getPath(source, 'list.0')).toBe(1)
    expect(getPath(null, 'a')).toBeUndefined()
  })
})

describe('deep-merge · deepClone', () => {
  it('clones arrays and nested objects', () => {
    const source = { list: [{ a: 1 }], nested: { b: 2 } }

    const copy = deepClone(source)

    expect(copy).toEqual(source)
    expect(copy).not.toBe(source)
    expect(copy.list).not.toBe(source.list)
    expect(copy.list[0]).not.toBe(source.list[0])
  })

  it('mutation of the copy does not reach the source', () => {
    const source = { nested: { b: 2 } }

    const copy = deepClone(source)
    copy.nested.b = 99

    expect(source.nested.b).toBe(2)
  })

  it('returns primitives unchanged', () => {
    expect(deepClone(1)).toBe(1)
    expect(deepClone('x')).toBe('x')
    expect(deepClone(null)).toBeNull()
  })
})
