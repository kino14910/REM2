import { describe, expect, it } from 'vitest'
import { validateManifest } from '../../src/kernel/discovery/manifest-validator.js'

const valid = {
  id: 'com.rem2.demo',
  name: 'Demo',
  version: '1.0.0',
  entry: 'dist/index.js',
  compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
}

describe('manifest-validator · valid input', () => {
  it('a minimal valid manifest passes', () => {
    const r = validateManifest(valid)
    expect(r.ok).toBe(true)
    expect(r.value?.id).toBe('com.rem2.demo')
  })

  it('a full field set passes', () => {
    const r = validateManifest({
      ...valid,
      dependencies: { 'com.rem2.other': '^1.0.0' },
      optionalDependencies: { 'com.rem2.opt': '~1.2.0' },
      requires: ['log.sink', 'config.provide'],
      author: 'team',
      description: 'demo',
      tags: ['a', 'b'],
    })
    expect(r.ok).toBe(true)
    expect(r.value?.requires).toContain('log.sink')
  })
})

describe('manifest-validator · invalid input', () => {
  it('a non-object is rejected', () => {
    expect(validateManifest(null).ok).toBe(false)
    expect(validateManifest('x').ok).toBe(false)
    expect(validateManifest([]).ok).toBe(false)
  })

  it('missing required fields is rejected', () => {
    const r = validateManifest({ name: 'x' })
    expect(r.ok).toBe(false)
    expect(r.issues.some(i => i.path === '$.id')).toBe(true)
  })

  it('an illegal id format is rejected', () => {
    const r = validateManifest({ ...valid, id: 'Bad ID!' })
    expect(r.ok).toBe(false)
  })

  it('a non-semver version is rejected', () => {
    const r = validateManifest({ ...valid, version: '1.0' })
    expect(r.ok).toBe(false)
    expect(r.issues.some(i => i.path === '$.version')).toBe(true)
  })

  it('missing compatibility is rejected', () => {
    const r = validateManifest({ ...valid, compatibility: undefined })
    expect(r.ok).toBe(false)
  })

  it('illegal capability names in requires are rejected', () => {
    const r = validateManifest({ ...valid, requires: ['Invalid CAP'] })
    expect(r.ok).toBe(false)
  })

  it('duplicate requires are rejected', () => {
    const r = validateManifest({
      ...valid,
      requires: ['log.sink', 'log.sink'],
    })
    expect(r.ok).toBe(false)
  })

  it('an illegal dependency range is rejected', () => {
    const r = validateManifest({ ...valid, dependencies: { other: '' } })
    expect(r.ok).toBe(false)
  })

  it('unknown fields are ignored (lenient)', () => {
    const r = validateManifest({ ...valid, unknownField: 123 })
    expect(r.ok).toBe(true)
  })
})
