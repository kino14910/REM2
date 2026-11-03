import { describe, expect, it } from 'vitest'

import type { Candidate } from '@/kernel/discovery/candidate.js'

import { DependencyResolver } from '@/kernel/dependency/resolver.js'

import { makeCandidate } from '../helpers/make-manifest.js'

const OPTS = { kernelVersion: '1.0.0', contractVersion: '1' } as const

function issueCodes(plan: ReturnType<DependencyResolver['resolve']>): string[] {
  return plan.issues.map(i => i.code)
}

/** Remove the compatibility block entirely (the type requires it, the runtime must cope). */
function withoutCompatibility(candidate: Candidate): Candidate {
  const manifest = { ...candidate.manifest }
  delete (manifest as { compatibility?: unknown }).compatibility
  return { ...candidate, manifest: manifest as Candidate['manifest'] }
}

describe('resolver · kernel version bounds', () => {
  it('accepts a plugin whose minKernel is satisfied', () => {
    const plan = new DependencyResolver().resolve(
      [
        makeCandidate({
          id: 'com.qa.ok',
          compatibility: { minKernel: '^1.0.0' },
        }),
      ],
      OPTS,
    )

    expect(plan.loadOrder).toEqual(['com.qa.ok'])
    expect(plan.issues).toEqual([])
  })

  it('drops a plugin that requires a newer kernel', () => {
    const plan = new DependencyResolver().resolve(
      [
        makeCandidate({
          id: 'com.qa.too-new',
          compatibility: { minKernel: '^2.0.0' },
        }),
      ],
      OPTS,
    )

    expect(plan.loadOrder).toEqual([])
    expect(plan.dropped).toEqual(['com.qa.too-new'])
    expect(issueCodes(plan)).toContain('E_INCOMPATIBLE')
    expect(plan.issues[0]?.detail).toMatch(/kernel version too low/)
  })

  it('accepts a plugin whose maxKernel is satisfied', () => {
    const plan = new DependencyResolver().resolve(
      [
        makeCandidate({
          id: 'com.qa.bounded',
          compatibility: { maxKernel: '1.5.0' },
        }),
      ],
      OPTS,
    )

    expect(plan.loadOrder).toEqual(['com.qa.bounded'])
  })

  it('drops a plugin whose maxKernel is below the running kernel', () => {
    const plan = new DependencyResolver().resolve(
      [
        makeCandidate({
          id: 'com.qa.pinned',
          compatibility: { maxKernel: '1.0.0' },
        }),
      ],
      { kernelVersion: '1.5.0', contractVersion: '1' },
    )

    expect(plan.dropped).toEqual(['com.qa.pinned'])
    expect(plan.issues[0]?.detail).toMatch(/kernel version too high/)
  })

  it('ignores a malformed maxKernel instead of failing the plugin', () => {
    const plan = new DependencyResolver().resolve(
      [
        makeCandidate({
          id: 'com.qa.bad-max',
          compatibility: { maxKernel: 'not-a-version' },
        }),
      ],
      OPTS,
    )

    expect(plan.loadOrder).toEqual(['com.qa.bad-max'])
    expect(plan.dropped).toEqual([])
  })

  it('treats a non-range minKernel as an exact version (2.10.x style typos are not silently accepted)', () => {
    const resolver = new DependencyResolver()

    const matching = resolver.resolve(
      [
        makeCandidate({
          id: 'com.qa.exact-ok',
          compatibility: { minKernel: '1.0.0' },
        }),
      ],
      OPTS,
    )
    const mismatched = resolver.resolve(
      [
        makeCandidate({
          id: 'com.qa.exact-no',
          compatibility: { minKernel: '1.0.1' },
        }),
      ],
      OPTS,
    )

    expect(matching.loadOrder).toEqual(['com.qa.exact-ok'])
    expect(mismatched.dropped).toEqual(['com.qa.exact-no'])
  })
})

describe('resolver · contract compatibility', () => {
  it('drops a plugin with a different contract major', () => {
    const plan = new DependencyResolver().resolve(
      [
        makeCandidate({
          id: 'com.qa.v2',
          compatibility: { contractVersion: '2' },
        }),
      ],
      OPTS,
    )

    expect(plan.dropped).toEqual(['com.qa.v2'])
    expect(plan.issues[0]?.detail).toMatch(/contract version incompatible/)
  })

  it('treats a non-numeric contract version as major 0', () => {
    const plan = new DependencyResolver().resolve(
      [
        makeCandidate({
          id: 'com.qa.garbage',
          compatibility: { contractVersion: 'abc' },
        }),
      ],
      OPTS,
    )

    expect(plan.dropped).toEqual(['com.qa.garbage'])
    expect(plan.issues[0]?.code).toBe('E_INCOMPATIBLE')
  })

  it('drops a plugin that omits the compatibility block', () => {
    const plan = new DependencyResolver().resolve(
      [withoutCompatibility(makeCandidate({ id: 'com.qa.bare' }))],
      OPTS,
    )

    expect(plan.dropped).toEqual(['com.qa.bare'])
    expect(plan.issues[0]?.detail).toMatch(/missing compatibility declaration/)
  })
})

describe('resolver · strict mode', () => {
  it('throws on the first error instead of returning a plan', () => {
    const resolver = new DependencyResolver()

    expect(() =>
      resolver.resolve(
        [
          makeCandidate({
            id: 'com.qa.needy',
            dependencies: { 'com.qa.absent': '^1.0.0' },
          }),
        ],
        { ...OPTS, onError: 'strict' },
      ),
    ).toThrow(/dependency resolution failed \(strict\): E_MISSING_DEPENDENCY/)
  })

  it('does not throw when only warnings were recorded', () => {
    const resolver = new DependencyResolver()

    const plan = resolver.resolve(
      [
        makeCandidate({
          id: 'com.qa.soft',
          optionalDependencies: { 'com.qa.absent': '^1.0.0' },
        }),
      ],
      { ...OPTS, onError: 'strict' },
    )

    expect(plan.loadOrder).toEqual(['com.qa.soft'])
    expect(issueCodes(plan)).toEqual(['W_MISSING_OPTIONAL'])
  })

  it('graceful mode returns the plan with the failing plugin dropped', () => {
    const plan = new DependencyResolver().resolve(
      [
        makeCandidate({
          id: 'com.qa.needy',
          dependencies: { 'com.qa.absent': '^1.0.0' },
        }),
      ],
      { ...OPTS, onError: 'graceful' },
    )

    expect(plan.loadOrder).toEqual([])
    expect(plan.dropped).toEqual(['com.qa.needy'])
  })
})

describe('resolver · duplicate id arbitration', () => {
  const resolveOne = (candidates: Candidate[]) =>
    new DependencyResolver().resolve(candidates, OPTS)

  it('keeps the builtin copy over the user copy', () => {
    const plan = resolveOne([
      makeCandidate({ id: 'com.qa.dup', source: 'user', version: '1.0.0' }),
      makeCandidate({ id: 'com.qa.dup', source: 'builtin', version: '1.0.0' }),
    ])

    expect(plan.loadOrder).toEqual(['com.qa.dup'])
    expect(plan.steps[0]?.candidate.source).toBe('builtin')
    expect(issueCodes(plan)).toContain('E_DUPLICATE_ID')
  })

  it('keeps the higher major version within one source', () => {
    const plan = resolveOne([
      makeCandidate({ id: 'com.qa.dup', version: '1.9.9' }),
      makeCandidate({ id: 'com.qa.dup', version: '2.0.0' }),
    ])

    expect(plan.steps[0]?.candidate.manifest.version).toBe('2.0.0')
  })

  it('falls through to minor and then patch', () => {
    const minor = resolveOne([
      makeCandidate({ id: 'com.qa.dup', version: '1.2.9' }),
      makeCandidate({ id: 'com.qa.dup', version: '1.3.0' }),
    ])
    const patch = resolveOne([
      makeCandidate({ id: 'com.qa.dup', version: '1.3.1' }),
      makeCandidate({ id: 'com.qa.dup', version: '1.3.0' }),
    ])

    expect(minor.steps[0]?.candidate.manifest.version).toBe('1.3.0')
    expect(patch.steps[0]?.candidate.manifest.version).toBe('1.3.1')
  })

  it('keeps the first entry when a duplicate version cannot be parsed', () => {
    const plan = resolveOne([
      makeCandidate({ id: 'com.qa.dup', version: 'not-a-version' }),
      makeCandidate({ id: 'com.qa.dup', version: 'also-bad' }),
    ])

    expect(plan.loadOrder).toEqual(['com.qa.dup'])
    expect(plan.steps[0]?.candidate.manifest.version).toBe('not-a-version')
  })

  it('records the ignored copy in the warning detail', () => {
    const plan = resolveOne([
      makeCandidate({ id: 'com.qa.dup', source: 'user', version: '1.0.0' }),
      makeCandidate({ id: 'com.qa.dup', source: 'builtin', version: '1.0.0' }),
    ])

    const warning = plan.issues.find(i => i.code === 'E_DUPLICATE_ID')
    expect(warning?.level).toBe('warn')
    expect(warning?.detail).toMatch(
      /keeping builtin@1\.0\.0, ignoring user@1\.0\.0/,
    )
  })
})

describe('resolver · satisfies fallback for invalid ranges', () => {
  it('compares exactly when the range is not a range', () => {
    const resolver = new DependencyResolver()

    expect(resolver.satisfies('1.2.3', 'not-a-range')).toBe(false)
    expect(resolver.satisfies('1.2.3', '1.2.3')).toBe(true)
    expect(resolver.satisfies('1.2.4', '1.2.3')).toBe(false)
  })

  it('returns false when neither side parses as a version', () => {
    const resolver = new DependencyResolver()

    expect(resolver.satisfies('garbage', 'also-garbage')).toBe(false)
  })
})
