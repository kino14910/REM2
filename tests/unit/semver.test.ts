import { describe, expect, it } from 'vitest'
import {
  compare,
  compareVersions,
  formatVersion,
  isValidVersion,
  parseVersion,
} from '../../src/kernel/semver/semver.js'
import {
  isValidRange,
  satisfies,
  withinRange,
} from '../../src/kernel/semver/range.js'

describe('semver · parseVersion', () => {
  it('parses three-segment versions', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
  })

  it('parses prerelease identifiers', () => {
    expect(parseVersion('1.0.0-alpha.1')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: 'alpha.1',
    })
  })

  it('ignores build metadata', () => {
    expect(parseVersion('1.2.3+build.9')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
    })
  })

  it('rejects two-segment versions (the source of the REM bug)', () => {
    expect(() => parseVersion('2.10')).toThrow(TypeError)
  })

  it('rejects illegal strings', () => {
    expect(() => parseVersion('abc')).toThrow()
    expect(() => parseVersion('')).toThrow()
    expect(isValidVersion('1.2.3')).toBe(true)
    expect(isValidVersion('1.2')).toBe(false)
  })
})

describe('semver · compare', () => {
  it('compares in major > minor > patch order', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1) // numeric comparison, not lexicographic
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1)
  })

  it('prerelease versions rank below their corresponding release', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBe(-1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
  })

  it('compare compares SemVer objects directly', () => {
    expect(
      compare(
        { major: 1, minor: 0, patch: 0 },
        { major: 1, minor: 0, patch: 1 },
      ),
    ).toBe(-1)
  })

  it('formatVersion round-trips', () => {
    expect(formatVersion(parseVersion('1.2.3-beta.1'))).toBe('1.2.3-beta.1')
  })
})

describe('semver · satisfies', () => {
  it('an exact match', () => {
    expect(satisfies('1.2.3', '1.2.3')).toBe(true)
    expect(satisfies('1.2.4', '1.2.3')).toBe(false)
  })

  it('caret ^', () => {
    expect(satisfies('1.5.0', '^1.2.3')).toBe(true)
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false)
    expect(satisfies('0.2.5', '^0.2.3')).toBe(true)
    expect(satisfies('0.3.0', '^0.2.3')).toBe(false)
    expect(satisfies('0.0.4', '^0.0.3')).toBe(true)
    expect(satisfies('0.0.5', '^0.0.3')).toBe(false)
  })

  it('tilde ~', () => {
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true)
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false)
  })

  it('comparison operators', () => {
    expect(satisfies('1.2.3', '>=1.2.0')).toBe(true)
    expect(satisfies('1.1.9', '>=1.2.0')).toBe(false)
    expect(satisfies('1.2.3', '>1.2.3')).toBe(false)
    expect(satisfies('1.2.4', '>1.2.3')).toBe(true)
    expect(satisfies('1.2.3', '<=1.2.3')).toBe(true)
    expect(satisfies('1.2.0', '<1.2.3')).toBe(true)
  })

  it('wildcards * and x', () => {
    expect(satisfies('9.9.9', '*')).toBe(true)
    expect(satisfies('1.5.0', '1.x')).toBe(true)
    expect(satisfies('2.0.0', '1.x')).toBe(false)
    expect(satisfies('1.2.9', '1.2.x')).toBe(true)
    expect(satisfies('1.3.0', '1.2.x')).toBe(false)
  })

  it('union ||', () => {
    expect(satisfies('1.5.0', '^1.0.0 || ^2.0.0')).toBe(true)
    expect(satisfies('2.5.0', '^1.0.0 || ^2.0.0')).toBe(true)
    expect(satisfies('3.0.0', '^1.0.0 || ^2.0.0')).toBe(false)
  })

  it('AND conjunction (space)', () => {
    expect(satisfies('1.5.0', '>=1.0.0 <2.0.0')).toBe(true)
    expect(satisfies('2.0.0', '>=1.0.0 <2.0.0')).toBe(false)
  })

  it('hyphen range', () => {
    expect(satisfies('1.5.0', '1.0.0 - 2.0.0')).toBe(false) // the `-` syntax is unimplemented, treated as invalid
  })

  it('prereleases do not satisfy ranges by default', () => {
    expect(satisfies('1.2.3-beta', '^1.0.0')).toBe(false)
  })

  it('isValidRange decisions', () => {
    expect(isValidRange('^1.0.0')).toBe(true)
    expect(isValidRange('')).toBe(false)
    expect(isValidRange('>=1.0.0 <2.0.0')).toBe(true)
  })

  it('withinRange combined decisions', () => {
    expect(withinRange('1.5.0', '^1.0.0')).toBe(true)
    expect(withinRange('2.0.0', '^1.0.0')).toBe(false)
    expect(withinRange('1.0.0', '1.0.0', '2.0.0')).toBe(true)
    expect(withinRange('2.0.0', '1.0.0', '2.0.0')).toBe(false)
  })
})
