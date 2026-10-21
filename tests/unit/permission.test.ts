import { describe, expect, it } from 'vitest'
import { CapabilityGuard } from '../../src/kernel/security/capability-guard.js'
import { PermissionManager } from '../../src/kernel/security/permission-manager.js'
import { CapabilityDeniedError } from '../../src/kernel/errors.js'
import { makeManifest } from '../helpers/make-manifest.js'

describe('permission · authorization decisions', () => {
  it('trusted grants regular capabilities by default', () => {
    const pm = new PermissionManager()
    const decision = pm.check(
      makeManifest({ id: 'a', requires: ['log.sink', 'command.provide'] }),
      'trusted',
    )
    expect(decision.granted).toContain('log.sink')
    expect(decision.granted).toContain('command.provide')
  })

  it('sandboxed denies sensitive capabilities by default', () => {
    const pm = new PermissionManager()
    const decision = pm.check(
      makeManifest({ id: 'a', requires: ['net.listen', 'fs.write'] }),
      'sandboxed',
    )
    expect(decision.denied).toContain('net.listen')
    expect(decision.denied).toContain('fs.write')
    expect(decision.warnings.length).toBeGreaterThan(0)
  })

  it('sandboxed denies capabilities outside the default set by default', () => {
    const pm = new PermissionManager()
    const decision = pm.check(
      makeManifest({ id: 'a', requires: ['command.provide'] }),
      'sandboxed',
    )
    expect(decision.denied).toContain('command.provide')
  })

  it('a runtime grant adds authorization', () => {
    const pm = new PermissionManager()
    pm.check(makeManifest({ id: 'a', requires: ['net.listen'] }), 'sandboxed')
    expect(pm.get('a')!.isGranted('net.listen')).toBe(false)
    pm.grant('a', 'net.listen')
    expect(pm.get('a')!.isGranted('net.listen')).toBe(true)
  })
})

describe('permission · CapabilityGuard blocking', () => {
  it('calling an unauthorized capability throws CapabilityDeniedError', () => {
    const guard = new CapabilityGuard()
    const pm = new PermissionManager(guard)
    pm.check(makeManifest({ id: 'a', requires: ['net.listen'] }), 'sandboxed')

    guard.declareServiceCapability('svc.x', 'net.listen')
    expect(() => guard.assert('svc.x', 'a')).toThrow(CapabilityDeniedError)
  })

  it('authorized capabilities pass', () => {
    const guard = new CapabilityGuard()
    const pm = new PermissionManager(guard)
    pm.check(makeManifest({ id: 'a', requires: ['log.sink'] }), 'trusted')
    guard.declareServiceCapability('svc.log', 'log.sink')
    expect(() => guard.assert('svc.log', 'a')).not.toThrow()
  })

  it('a service without a declared capability is open to everyone', () => {
    const guard = new CapabilityGuard()
    expect(() => guard.assert('svc.public', 'anyone')).not.toThrow()
  })

  it('the kernel itself is always allowed', () => {
    const guard = new CapabilityGuard()
    guard.declareServiceCapability('svc.x', 'net.listen')
    expect(() => guard.assert('svc.x', 'kernel')).not.toThrow()
  })

  it('denied counts are recorded', () => {
    const guard = new CapabilityGuard()
    guard.declareServiceCapability('svc.x', 'net.listen')
    try {
      guard.assert('svc.x', 'evil')
    } catch {
      /* expected */
    }
    expect(guard.deniedTotal).toBe(1)
  })
})
