import { describe, expect, it } from 'vitest'
import { validateManifest } from '../../src/kernel/discovery/manifest-validator.js'

const base = {
  id: 'com.qa.demo',
  name: 'Demo',
  version: '1.0.0',
  entry: 'dist/index.js',
  compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
} as const

describe('manifest-boundary · required fields', () => {
  it('an empty object reports every missing field', () => {
    const r = validateManifest({})
    expect(r.ok).toBe(false)
    const paths = r.issues.map(i => i.path)
    expect(paths).toEqual(
      expect.arrayContaining([
        '$.id',
        '$.name',
        '$.version',
        '$.entry',
        '$.compatibility',
      ]),
    )
  })

  it('a missing entry is rejected', () => {
    const r = validateManifest({
      id: base.id,
      name: base.name,
      version: base.version,
      compatibility: base.compatibility,
    })
    expect(r.ok).toBe(false)
    expect(r.issues.some(i => i.path === '$.entry')).toBe(true)
  })

  it('compatibility missing minKernel / contractVersion is rejected', () => {
    const r = validateManifest({ ...base, compatibility: {} })
    expect(r.ok).toBe(false)
    expect(r.issues.some(i => i.path === '$.compatibility.minKernel')).toBe(
      true,
    )
    expect(
      r.issues.some(i => i.path === '$.compatibility.contractVersion'),
    ).toBe(true)
  })

  it('a blank name string is rejected', () => {
    expect(validateManifest({ ...base, name: '   ' }).ok).toBe(false)
  })
})

describe('manifest-boundary · id rules', () => {
  it.each([
    ['ab'], // length < 3
    ['A-B'], // uppercase
    ['-bad'], // leading hyphen
    ['bad-'], // trailing hyphen
    ['has space'],
    ['bad!'],
    ['.bad'],
    ['bad_!'],
  ])('rejects an illegal id: %s', id => {
    expect(validateManifest({ ...base, id }).ok).toBe(false)
  })

  it('accepts reverse-DNS and dotted ids', () => {
    expect(validateManifest({ ...base, id: 'com.rem2.hello-command' }).ok).toBe(
      true,
    )
    expect(validateManifest({ ...base, id: 'abc' }).ok).toBe(true)
  })
})

describe('manifest-boundary · version rules', () => {
  it.each([['1.0'], ['v1.0.0'], ['1.0.0.0'], ['abc'], [''], ['1.0.0-']])(
    'rejects an illegal version: %s',
    version => {
      expect(validateManifest({ ...base, version }).ok).toBe(false)
    },
  )

  it('accepts versions with prerelease identifiers', () => {
    expect(validateManifest({ ...base, version: '1.0.0-beta.1' }).ok).toBe(true)
  })

  it('maxKernel must be an exact version (ranges are not accepted)', () => {
    expect(
      validateManifest({
        ...base,
        compatibility: { ...base.compatibility, maxKernel: '^2.0.0' },
      }).ok,
    ).toBe(false)
    expect(
      validateManifest({
        ...base,
        compatibility: { ...base.compatibility, maxKernel: '2.0.0' },
      }).ok,
    ).toBe(true)
  })
})

describe('manifest-boundary · requires rules', () => {
  it.each([
    ['Bad Cap'],
    ['1abc'],
    ['UPPER'],
    ['has_underscore'],
    ['a..b'],
    ['-x'],
    [''],
  ])('rejects an illegal capability name: %s', cap => {
    expect(validateManifest({ ...base, requires: [cap] }).ok).toBe(false)
  })

  it('duplicate capabilities are rejected', () => {
    const r = validateManifest({
      ...base,
      requires: ['log.sink', 'log.sink'],
    })
    expect(r.ok).toBe(false)
    expect(r.issues.some(i => i.message.includes('duplicate'))).toBe(true)
  })

  it('multiple distinct capabilities pass', () => {
    expect(
      validateManifest({
        ...base,
        requires: ['log.sink', 'config.provide'],
      }).ok,
    ).toBe(true)
  })
})

describe('manifest-boundary · dependency rules', () => {
  it('an illegal range is rejected', () => {
    expect(
      validateManifest({
        ...base,
        dependencies: { 'com.qa.dep': 'not a range' },
      }).ok,
    ).toBe(false)
  })

  it('an illegal dependency id is rejected', () => {
    expect(
      validateManifest({ ...base, dependencies: { BAD: '^1.0.0' } }).ok,
    ).toBe(false)
  })

  it('a non-string dependency range is rejected', () => {
    expect(
      validateManifest({ ...base, dependencies: { 'com.qa.dep': 123 } }).ok,
    ).toBe(false)
  })

  it('non-object dependencies is rejected', () => {
    expect(validateManifest({ ...base, dependencies: 'nope' }).ok).toBe(false)
  })

  it('optionalDependencies are validated the same way', () => {
    expect(
      validateManifest({
        ...base,
        optionalDependencies: { 'com.qa.opt': 'bogus range' },
      }).ok,
    ).toBe(false)
  })
})
