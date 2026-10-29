import { describe, expect, it } from 'vitest'
import {
  isNewerVersion,
  normalizeVersion,
} from '../../src/host/plugins/update-compare.js'

describe('unit · update compare', () => {
  it('normalizes surrounding whitespace and a leading v or V', () => {
    expect(normalizeVersion('  v1.2.3  ')).toBe('1.2.3')
    expect(normalizeVersion('V2.0.0-alpha.1')).toBe('2.0.0-alpha.1')
  })

  it('detects upgrades and downgrades numerically', () => {
    expect(isNewerVersion('1.9.0', '1.10.0')).toBe(true)
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(false)
    expect(isNewerVersion('1.2.3', '1.2.4')).toBe(true)
  })

  it('normalizes both versions before comparing', () => {
    expect(isNewerVersion(' v1.2.3 ', 'V1.3.0')).toBe(true)
  })

  it('uses kernel prerelease ordering', () => {
    expect(isNewerVersion('1.0.0-alpha', '1.0.0')).toBe(true)
    expect(isNewerVersion('1.0.0', '1.0.0-beta')).toBe(false)
    expect(isNewerVersion('1.0.0-alpha.1', '1.0.0-alpha.2')).toBe(true)
  })

  it('returns false for invalid input on either side', () => {
    expect(isNewerVersion('not-a-version', '1.0.0')).toBe(false)
    expect(isNewerVersion('1.0.0', '1.0')).toBe(false)
    expect(isNewerVersion('', '')).toBe(false)
  })

  it('returns false for equal versions', () => {
    expect(isNewerVersion('1.2.3', 'v1.2.3')).toBe(false)
    expect(isNewerVersion('1.2.3+one', '1.2.3+two')).toBe(false)
  })
})
