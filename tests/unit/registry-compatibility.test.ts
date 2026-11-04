import { describe, expect, it } from 'vitest'

import { evaluateRegistryVersionCompatibility } from '@/host/registry/compatibility.js'
import { RegistryClientError } from '@/host/registry/errors.js'

import { makeRegistryVersion } from '../helpers/registry-index.js'

const host = { kernelVersion: '1.0.0', contractVersion: '1' }

describe('unit · registry compatibility', () => {
  it('accepts a plugin built for the current kernel and contract', () => {
    const result = evaluateRegistryVersionCompatibility(
      makeRegistryVersion(),
      host,
    )
    expect(result).toEqual({ compatible: true, issues: [] })
  })

  it('accepts another patch and minor release of the same major', () => {
    const result = evaluateRegistryVersionCompatibility(makeRegistryVersion(), {
      kernelVersion: '1.4.2',
      contractVersion: '1.2',
    })
    expect(result.compatible).toBe(true)
  })

  it('rejects a kernel below minKernel', () => {
    const result = evaluateRegistryVersionCompatibility(
      makeRegistryVersion({
        compatibility: { minKernel: '^2.0.0', contractVersion: '1' },
      }),
      host,
    )
    expect(result.compatible).toBe(false)
    expect(result.issues.map(item => item.code)).toEqual(['min-kernel'])
  })

  it('treats maxKernel as an exclusive upper bound', () => {
    const version = makeRegistryVersion({
      compatibility: {
        minKernel: '^1.0.0',
        maxKernel: '2.0.0',
        contractVersion: '1',
      },
    })
    expect(
      evaluateRegistryVersionCompatibility(version, {
        kernelVersion: '1.9.9',
        contractVersion: '1',
      }).compatible,
    ).toBe(true)
    expect(
      evaluateRegistryVersionCompatibility(version, {
        kernelVersion: '2.0.0',
        contractVersion: '1',
      }).compatible,
    ).toBe(false)
  })

  it('rejects a different contract major', () => {
    const result = evaluateRegistryVersionCompatibility(
      makeRegistryVersion({
        compatibility: { minKernel: '^1.0.0', contractVersion: '2' },
      }),
      host,
    )
    expect(result.compatible).toBe(false)
    expect(result.issues.map(item => item.code)).toEqual(['contract-version'])
  })

  it('flags malformed compatibility fields', () => {
    const result = evaluateRegistryVersionCompatibility(
      makeRegistryVersion({
        compatibility: { minKernel: 'nonsense', contractVersion: 'beta' },
      }),
      host,
    )
    expect(result.compatible).toBe(false)
    expect(result.issues.map(item => item.code)).toEqual([
      'contract-version',
      'invalid-min-kernel',
    ])
  })

  it('throws a compatibility error when the host version is invalid', () => {
    expect(() =>
      evaluateRegistryVersionCompatibility(makeRegistryVersion(), {
        kernelVersion: 'not-semver',
        contractVersion: '1',
      }),
    ).toThrow(RegistryClientError)

    expect(() =>
      evaluateRegistryVersionCompatibility(makeRegistryVersion(), {
        kernelVersion: '1.0.0',
        contractVersion: 'v1',
      }),
    ).toThrow(RegistryClientError)
  })
})
