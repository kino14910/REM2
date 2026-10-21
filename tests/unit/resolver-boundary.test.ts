import { describe, expect, it } from 'vitest'
import { DependencyResolver } from '../../src/kernel/dependency/resolver.js'
import { makeCandidate } from '../helpers/make-manifest.js'

const OPTS = { kernelVersion: '1.0.0', contractVersion: '1' } as const

/** Deterministic shuffle (LCG) used to produce different input orders. */
function shuffle<T>(input: readonly T[], seed: number): T[] {
  const arr = input.slice()
  let s = seed
  for (let i = arr.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const j = s % (i + 1)
    const tmp = arr[i]!
    arr[i] = arr[j]!
    arr[j] = tmp
  }
  return arr
}

describe('resolver-boundary · deterministic topological sort', () => {
  const base = [
    makeCandidate({ id: 'com.qa.a' }),
    makeCandidate({ id: 'com.qa.b', dependencies: { 'com.qa.a': '^1.0.0' } }),
    makeCandidate({ id: 'com.qa.c', dependencies: { 'com.qa.b': '^1.0.0' } }),
    makeCandidate({ id: 'com.qa.d' }),
    makeCandidate({ id: 'com.qa.e', dependencies: { 'com.qa.d': '^1.0.0' } }),
    makeCandidate({ id: 'com.qa.f' }),
  ]

  it('loadOrder is identical under any input order', () => {
    const resolver = new DependencyResolver()
    const expected = resolver.resolve(base, OPTS).loadOrder

    for (let seed = 1; seed <= 40; seed += 1) {
      const plan = resolver.resolve(shuffle(base, seed), OPTS)
      expect(plan.loadOrder).toEqual(expected)
    }
  })

  it('hard dependencies come before dependents', () => {
    const resolver = new DependencyResolver()
    const order = resolver.resolve(base, OPTS).loadOrder
    expect(order.indexOf('com.qa.a')).toBeLessThan(order.indexOf('com.qa.b'))
    expect(order.indexOf('com.qa.b')).toBeLessThan(order.indexOf('com.qa.c'))
    expect(order.indexOf('com.qa.d')).toBeLessThan(order.indexOf('com.qa.e'))
  })

  it('dependency-free plugins load in id lexicographic order', () => {
    const resolver = new DependencyResolver()
    const plan = resolver.resolve(
      [
        makeCandidate({ id: 'com.qa.z' }),
        makeCandidate({ id: 'com.qa.m' }),
        makeCandidate({ id: 'com.qa.a' }),
      ],
      OPTS,
    )
    expect(plan.loadOrder).toEqual(['com.qa.a', 'com.qa.m', 'com.qa.z'])
  })
})

describe('resolver-boundary · hard dependency failures', () => {
  it('missing hard dependency → the dependent is dropped with E_MISSING_DEPENDENCY', () => {
    const resolver = new DependencyResolver()
    const plan = resolver.resolve(
      [
        makeCandidate({ id: 'com.qa.solo' }),
        makeCandidate({
          id: 'com.qa.needs',
          dependencies: { 'com.qa.absent': '^1.0.0' },
        }),
      ],
      OPTS,
    )
    expect(plan.loadOrder).toContain('com.qa.solo')
    expect(plan.loadOrder).not.toContain('com.qa.needs')
    expect(plan.dropped).toContain('com.qa.needs')
    expect(
      plan.issues.some(
        i => i.code === 'E_MISSING_DEPENDENCY' && i.pluginId === 'com.qa.needs',
      ),
    ).toBe(true)
  })

  it('hard dependency version mismatch → the dependent is dropped with E_VERSION_MISMATCH', () => {
    const resolver = new DependencyResolver()
    const plan = resolver.resolve(
      [
        makeCandidate({ id: 'com.qa.a', version: '1.0.0' }),
        makeCandidate({
          id: 'com.qa.b',
          dependencies: { 'com.qa.a': '^2.0.0' },
        }),
      ],
      OPTS,
    )
    expect(plan.loadOrder).toEqual(['com.qa.a'])
    expect(plan.dropped).toContain('com.qa.b')
    expect(plan.issues.some(i => i.code === 'E_VERSION_MISMATCH')).toBe(true)
  })

  it('a dropped hard dependency → cascading drop of the whole chain', () => {
    const resolver = new DependencyResolver()
    const plan = resolver.resolve(
      [
        makeCandidate({
          id: 'com.qa.top',
          dependencies: { 'com.qa.mid': '^1.0.0' },
        }),
        makeCandidate({
          id: 'com.qa.mid',
          dependencies: { 'com.qa.root': '^1.0.0' },
        }),
        // com.qa.root is intentionally missing
        makeCandidate({ id: 'com.qa.other' }),
      ],
      OPTS,
    )
    expect(plan.dropped).toEqual(
      expect.arrayContaining(['com.qa.mid', 'com.qa.top']),
    )
    expect(plan.loadOrder).toEqual(['com.qa.other'])
  })
})

describe('resolver-boundary · optional dependencies', () => {
  it('missing optional dependency → the plugin is not dropped, only W_MISSING_OPTIONAL', () => {
    const resolver = new DependencyResolver()
    const plan = resolver.resolve(
      [
        makeCandidate({
          id: 'com.qa.a',
          optionalDependencies: { 'com.qa.opt': '^1.0.0' },
        }),
      ],
      OPTS,
    )
    expect(plan.loadOrder).toEqual(['com.qa.a'])
    expect(plan.dropped).toEqual([])
    const warn = plan.issues.find(i => i.code === 'W_MISSING_OPTIONAL')
    expect(warn?.level).toBe('warn')
  })

  it('optional dependency version mismatch → still not dropped, warning only', () => {
    const resolver = new DependencyResolver()
    const plan = resolver.resolve(
      [
        makeCandidate({ id: 'com.qa.opt', version: '1.0.0' }),
        makeCandidate({
          id: 'com.qa.a',
          optionalDependencies: { 'com.qa.opt': '^9.0.0' },
        }),
      ],
      OPTS,
    )
    expect(plan.dropped).toEqual([])
    expect(plan.loadOrder).toContain('com.qa.a')
    expect(plan.issues.some(i => i.code === 'W_MISSING_OPTIONAL')).toBe(true)
  })
})

describe('resolver-boundary · cycles and compatibility', () => {
  it('an all-hard-edge cycle → none loaded, E_CYCLE reported', () => {
    const resolver = new DependencyResolver()
    const plan = resolver.resolve(
      [
        makeCandidate({
          id: 'com.qa.x',
          dependencies: { 'com.qa.y': '^1.0.0' },
        }),
        makeCandidate({
          id: 'com.qa.y',
          dependencies: { 'com.qa.x': '^1.0.0' },
        }),
      ],
      OPTS,
    )
    expect(plan.loadOrder).toEqual([])
    expect(plan.issues.some(i => i.code === 'E_CYCLE')).toBe(true)
  })

  it('contract major mismatch → dropped with E_INCOMPATIBLE', () => {
    const resolver = new DependencyResolver()
    const plan = resolver.resolve(
      [
        makeCandidate({
          id: 'com.qa.a',
          compatibility: { contractVersion: '2' },
        }),
      ],
      OPTS,
    )
    expect(plan.loadOrder).toEqual([])
    expect(plan.issues.some(i => i.code === 'E_INCOMPATIBLE')).toBe(true)
  })

  it('duplicate id → deduplicated to a single one, E_DUPLICATE_ID reported (warn)', () => {
    const resolver = new DependencyResolver()
    const plan = resolver.resolve(
      [
        makeCandidate({ id: 'com.qa.dup', source: 'user', version: '1.0.0' }),
        makeCandidate({
          id: 'com.qa.dup',
          source: 'builtin',
          version: '1.0.0',
        }),
      ],
      OPTS,
    )
    expect(plan.loadOrder).toEqual(['com.qa.dup'])
    expect(plan.issues.some(i => i.code === 'E_DUPLICATE_ID')).toBe(true)
  })
})
