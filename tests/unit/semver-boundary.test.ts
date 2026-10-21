/**
 * Boundary tests for semver.
 *
 * These prove that REM's known bug (`ver.split('.')` making `2.10` < `2.9`)
 * is fixed here: versions compare numerically, not lexicographically.
 */

import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  parseVersion,
} from '../../src/kernel/semver/semver.js'
import { isValidRange, satisfies } from '../../src/kernel/semver/range.js'

describe('semver-boundary · REM known-bug regression', () => {
  it('2.10.0 > 2.9.0 (numeric comparison, not lexicographic)', () => {
    expect(compareVersions('2.10.0', '2.9.0')).toBe(1)
    expect(compareVersions('2.9.0', '2.10.0')).toBe(-1)
  })

  it('1.10.0 > 1.9.0 and 1.2.10 > 1.2.9', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1)
  })

  it('the two-segment version 2.10 is rejected (root cause of the REM bug)', () => {
    expect(() => parseVersion('2.10')).toThrow(TypeError)
  })

  it('range checks use numeric comparison too: ^2.9.0 accepts 2.10.0', () => {
    expect(satisfies('2.10.0', '^2.9.0')).toBe(true)
    expect(satisfies('2.9.0', '^2.10.0')).toBe(false)
  })
})

describe('semver-boundary · prerelease semantics', () => {
  it('prerelease < corresponding release', () => {
    expect(compareVersions('2.0.0-alpha', '2.0.0')).toBe(-1)
    expect(compareVersions('2.0.0', '2.0.0-alpha')).toBe(1)
  })

  it('numeric identifiers rank below alphanumeric ones (semver rule)', () => {
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-1')).toBe(1)
  })

  it('numeric identifiers compare numerically: alpha.10 > alpha.9', () => {
    expect(compareVersions('1.0.0-alpha.10', '1.0.0-alpha.9')).toBe(1)
  })

  it('fewer segments rank lower: alpha < alpha.1', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
  })

  it('prereleases do not satisfy ranges by default unless the range explicitly includes the same-core prerelease', () => {
    expect(satisfies('2.0.0-beta.1', '^2.0.0')).toBe(false)
    expect(satisfies('2.0.0-beta.1', '>=2.0.0-beta.0 <2.0.0')).toBe(true)
  })
})

describe('semver-boundary · range boundaries', () => {
  it('the caret upper bound is excluded: 2.0.0 does not satisfy ^1.9.0', () => {
    expect(satisfies('2.0.0', '^1.9.0')).toBe(false)
    expect(satisfies('1.99.99', '^1.9.0')).toBe(true)
  })

  it('tilde locks the minor only: ~1.2.0 excludes 1.3.0', () => {
    expect(satisfies('1.2.99', '~1.2.0')).toBe(true)
    expect(satisfies('1.3.0', '~1.2.0')).toBe(false)
  })

  it('an exact match does not do prefix matching', () => {
    expect(satisfies('1.2.3', '1.2.3')).toBe(true)
    expect(satisfies('1.2.30', '1.2.3')).toBe(false)
  })

  it('the unimplemented `-` syntax is an invalid range and unsatisfied (no throw)', () => {
    expect(isValidRange('1.0.0 - 2.0.0')).toBe(false)
    expect(satisfies('1.5.0', '1.0.0 - 2.0.0')).toBe(false)
  })
})
