import { describe, expect, it } from 'vitest'

import { isValidRange, satisfies, withinRange } from '@/kernel/semver/range.js'

describe('semver-range · caret and tilde edge forms', () => {
  it('treats ^x / ^X as unconstrained', () => {
    expect(satisfies('0.0.1', '^x')).toBe(true)
    expect(satisfies('9.9.9', '^X')).toBe(true)
    expect(isValidRange('^x')).toBe(true)
  })

  it('accepts wildcard segments inside a caret', () => {
    expect(satisfies('1.9.9', '^1.x')).toBe(true)
    expect(satisfies('2.0.0', '^1.x')).toBe(false)
    expect(satisfies('1.2.9', '^1.2.x')).toBe(true)
    expect(satisfies('1.2.0', '^1.2.x')).toBe(true)
    expect(satisfies('1.1.9', '^1.2.x')).toBe(false)
  })

  it('keeps the prerelease of the caret lower bound', () => {
    expect(isValidRange('^1.2.3-beta.1')).toBe(true)
    expect(satisfies('1.2.3-beta.1', '^1.2.3-beta.1')).toBe(true)
    expect(satisfies('1.2.3-beta.2', '^1.2.3-beta.1')).toBe(true)
    expect(satisfies('1.2.3', '^1.2.3-beta.1')).toBe(true)
    expect(satisfies('1.2.4-beta.1', '^1.2.3-beta.1')).toBe(false)
    expect(satisfies('1.1.0', '^1.2.3-beta.1')).toBe(false)

    // `~` reaches the same result through tryParse().
    expect(isValidRange('~1.2.3-beta.1')).toBe(true)
    expect(satisfies('1.2.3-beta.1', '~1.2.3-beta.1')).toBe(true)
  })

  it('rejects a caret or tilde with a non-numeric segment', () => {
    expect(isValidRange('^abc')).toBe(false)
    expect(satisfies('1.0.0', '^abc')).toBe(false)
    expect(isValidRange('~abc')).toBe(false)
  })
})

describe('semver-range · partial versions with an operator', () => {
  it('>= 1.2 means >= 1.2.0', () => {
    expect(satisfies('1.2.0', '>=1.2')).toBe(true)
    expect(satisfies('1.1.9', '>=1.2')).toBe(false)
  })

  it('> 1.2 bumps the minor (standard semver reading of a partial)', () => {
    expect(satisfies('1.2.9', '>1.2')).toBe(false)
    expect(satisfies('1.3.0', '>1.2')).toBe(true)
  })

  it('<= 1.2 excludes the whole next minor', () => {
    expect(satisfies('1.2.9', '<=1.2')).toBe(true)
    expect(satisfies('1.3.0', '<=1.2')).toBe(false)
  })

  it('a bare wildcard segment sets both bounds', () => {
    expect(satisfies('1.9.9', '1.x')).toBe(true)
    expect(satisfies('2.0.0', '1.x')).toBe(false)
    expect(satisfies('1.2.9', '1.2.x')).toBe(true)
    expect(satisfies('1.3.0', '1.2.x')).toBe(false)
  })
})

describe('semver-range · guards', () => {
  it('returns false instead of throwing on non-string input', () => {
    expect(satisfies(null as unknown as string, '1.0.0')).toBe(false)
    expect(satisfies('1.0.0', null as unknown as string)).toBe(false)
    expect(isValidRange(null as unknown as string)).toBe(false)
  })

  it('treats an empty range as invalid but unconstrained wildcards as valid', () => {
    expect(isValidRange('')).toBe(false)
    expect(isValidRange('*')).toBe(true)
    expect(satisfies('1.0.0', '*')).toBe(true)
  })

  it('a union factor that fails to compile invalidates the whole range', () => {
    expect(isValidRange('1.0.0 || ^abc')).toBe(false)
    expect(satisfies('1.0.0', '1.0.0 || ^abc')).toBe(false)
  })
})

describe('semver-range · withinRange', () => {
  it('uses range syntax when min is a range', () => {
    expect(withinRange('1.5.0', '^1.0.0')).toBe(true)
    expect(withinRange('2.0.0', '^1.0.0')).toBe(false)
  })

  it('treats a non-range min as an exact lower bound', () => {
    expect(withinRange('1.0.0', '1.0.0')).toBe(true)
    expect(withinRange('0.9.0', '1.0.0')).toBe(false)
  })

  it('applies an optional upper bound exclusively', () => {
    expect(withinRange('1.4.9', '^1.0.0', '1.5.0')).toBe(true)
    expect(withinRange('1.5.0', '^1.0.0', '1.5.0')).toBe(false)
  })

  it('ignores an unparsable upper bound', () => {
    expect(withinRange('1.5.0', '^1.0.0', 'garbage')).toBe(true)
  })

  it('rejects an unparsable version outright', () => {
    expect(withinRange('garbage', '^1.0.0')).toBe(false)
  })
})

describe('semver-range · compiled-range cache', () => {
  it('keeps answering correctly after the cache is evicted', () => {
    // CACHE_LIMIT is 512; more distinct ranges force an eviction.
    for (let i = 0; i < 600; i += 1) {
      isValidRange(`^1.${i}`)
    }

    expect(satisfies('1.599.0', '^1.599')).toBe(true)
    expect(satisfies('1.599.0', '^1.0')).toBe(true)
    expect(satisfies('2.0.0', '^1.599')).toBe(false)
  })
})
