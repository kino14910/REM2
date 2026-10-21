/**
 * Regression tests for hardening fixes. Each group guards a contract promise
 * that held in principle but had a gap in the implementation, previously
 * untested.
 */

import { describe, expect, it } from 'vitest'
import { ConfigService } from '../../src/kernel/config/config-service.js'
import type { ConfigProviderFailure } from '../../src/kernel/config/config-service.js'
import type { ConfigProvider } from '../../src/kernel/contracts/config.js'
import { DependencyResolver } from '../../src/kernel/dependency/resolver.js'
import { validateManifest } from '../../src/kernel/discovery/manifest-validator.js'
import { makeCandidate, makeManifest } from '../helpers/make-manifest.js'

// ─────────────────────────── 1. Config provider failures must be observable ───────────────────────────

describe('hardening · ConfigService provider failures are not silent', () => {
  function failingProvider(name: string, priority = 10): ConfigProvider {
    return {
      name,
      priority,
      async load(): Promise<Record<string, unknown>> {
        throw new Error(`failed to read ${name}`)
      },
    }
  }

  it('a failing provider is recorded in loadFailures, not silently swallowed', async () => {
    const svc = new ConfigService()
    svc.registerProvider(failingProvider('broken'))

    await svc.refresh()

    expect(svc.loadFailures).toHaveLength(1)
    expect(svc.loadFailures[0]?.provider).toBe('broken')
    expect(svc.loadFailures[0]?.error).toContain('failed to read')
  })

  it('failures are reported to the onProviderError callback (can feed logs/metrics)', async () => {
    const seen: ConfigProviderFailure[] = []
    const svc = new ConfigService({ onProviderError: f => seen.push(f) })
    svc.registerProvider(failingProvider('broken'))

    await svc.refresh()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.provider).toBe('broken')
  })

  it('a single provider failure does not block the other layers (merging still applies)', async () => {
    const svc = new ConfigService()
    svc.registerProvider(failingProvider('broken', 10))
    svc.registerProvider({
      name: 'ok',
      priority: 20,
      async load() {
        return { app: { name: 'rem2' } }
      },
    })

    await svc.refresh()

    // The healthy layer still applies
    expect(svc.get('app.name')).toBe('rem2')
    // The failing layer is recorded
    expect(svc.loadFailures.map(f => f.provider)).toEqual(['broken'])
  })

  it('clearLoadFailures clears the records', async () => {
    const svc = new ConfigService()
    svc.registerProvider(failingProvider('broken'))
    await svc.refresh()
    expect(svc.loadFailures).toHaveLength(1)

    svc.clearLoadFailures()
    expect(svc.loadFailures).toHaveLength(0)
  })
})

// ─────────────────────────── 2. Hard-edge cycle nodes must be reported as dropped ───────────────────────────

describe('hardening · all-hard-edge cycle nodes must be registered as dropped', () => {
  const OPTS = { kernelVersion: '1.0.0', contractVersion: '1' } as const

  it('mutually hard-dependent cycle → nodes absent from loadOrder but present in dropped', () => {
    const resolver = new DependencyResolver()
    const plan = resolver.resolve(
      [
        makeCandidate({
          id: 'com.qa.cyc-a',
          dependencies: { 'com.qa.cyc-b': '^1.0.0' },
        }),
        makeCandidate({
          id: 'com.qa.cyc-b',
          dependencies: { 'com.qa.cyc-a': '^1.0.0' },
        }),
        makeCandidate({ id: 'com.qa.solo' }),
      ],
      OPTS,
    )

    // Cycle nodes must not be loaded
    expect(plan.loadOrder).not.toContain('com.qa.cyc-a')
    expect(plan.loadOrder).not.toContain('com.qa.cyc-b')
    // Unrelated plugins still load
    expect(plan.loadOrder).toContain('com.qa.solo')

    // Key assertion: cycle nodes must be explicitly reported as dropped, not silently vanish
    expect(plan.dropped).toContain('com.qa.cyc-a')
    expect(plan.dropped).toContain('com.qa.cyc-b')

    // A diagnosable E_CYCLE issue must also be reported
    const cycleIssues = plan.issues.filter(i => i.code === 'E_CYCLE')
    expect(cycleIssues.length).toBeGreaterThanOrEqual(2)
    expect(cycleIssues.every(i => i.level === 'error')).toBe(true)
  })

  it('loadOrder + dropped cover every input candidate (no node vanishes)', () => {
    const resolver = new DependencyResolver()
    const candidates = [
      makeCandidate({
        id: 'com.qa.cyc-a',
        dependencies: { 'com.qa.cyc-b': '^1.0.0' },
      }),
      makeCandidate({
        id: 'com.qa.cyc-b',
        dependencies: { 'com.qa.cyc-a': '^1.0.0' },
      }),
      makeCandidate({
        id: 'com.qa.cyc-c',
        dependencies: { 'com.qa.cyc-a': '^1.0.0' },
      }),
      makeCandidate({ id: 'com.qa.solo' }),
    ]
    const plan = resolver.resolve(candidates, OPTS)

    const accounted = new Set([...plan.loadOrder, ...plan.dropped])
    for (const c of candidates) {
      expect(accounted.has(c.manifest.id)).toBe(true)
    }
  })
})

// ─────────────────────────── 3. id validation rejects consecutive separators ───────────────────────────

describe('hardening · plugin id rejects consecutive separators', () => {
  function idValid(id: string): boolean {
    const r = validateManifest(makeManifest({ id }))
    return r.ok
  }

  it('rejects ids containing consecutive separators', () => {
    expect(idValid('bad..id')).toBe(false)
    expect(idValid('bad--id')).toBe(false)
    expect(idValid('bad__id')).toBe(false)
    expect(idValid('bad.-id')).toBe(false)
  })

  it('rejects ids starting or ending with a separator', () => {
    expect(idValid('.bad')).toBe(false)
    expect(idValid('bad.')).toBe(false)
    expect(idValid('-bad')).toBe(false)
    expect(idValid('bad-')).toBe(false)
  })

  it('accepts legal ids (reverse-DNS, hyphens, underscores)', () => {
    expect(idValid('com.rem2.hello-command')).toBe(true)
    expect(idValid('com.example.my_plugin')).toBe(true)
    expect(idValid('com.rem2.config-json')).toBe(true)
    expect(idValid('abc')).toBe(true)
  })

  it('rejects ids shorter than 3 (existing constraint)', () => {
    expect(idValid('a')).toBe(false)
    expect(idValid('ab')).toBe(false)
  })

  it('rejects uppercase and spaces (existing constraints do not regress)', () => {
    expect(idValid('Com.Rem2.App')).toBe(false)
    expect(idValid('bad id')).toBe(false)
  })
})
