import { describe, expect, it } from 'vitest'

import type { PermissionSet } from '@/kernel/contracts/permission.js'

import { CapabilityDeniedError } from '@/kernel/errors.js'
import { CapabilityGuard } from '@/kernel/security/capability-guard.js'

function perms(pluginId: string, granted: string[] = []): PermissionSet {
  return {
    pluginId,
    granted,
    denied: [],
    isGranted: (capability: string) => granted.includes(capability),
  }
}

describe('capability-guard · service capabilities', () => {
  it('lets any caller through for a service without a declared capability', () => {
    const guard = new CapabilityGuard()

    expect(() =>
      guard.assert('public.service', 'com.rem2.anyone'),
    ).not.toThrow()
    expect(guard.deniedTotal).toBe(0)
  })

  it('denies a caller that has no permission set at all', () => {
    const guard = new CapabilityGuard()
    guard.declareServiceCapability('db.service', 'db.write')

    expect(() => guard.assert('db.service', 'com.rem2.stranger')).toThrow(
      CapabilityDeniedError,
    )
    expect(guard.deniedTotal).toBe(1)
  })

  it('denies a caller whose set does not include the capability', () => {
    const guard = new CapabilityGuard()
    guard.declareServiceCapability('db.service', 'db.write')
    guard.registerPermissions(perms('com.rem2.reader', ['db.read']))

    expect(() => guard.assert('db.service', 'com.rem2.reader')).toThrow(
      /db\.write/,
    )
  })

  it('allows a caller holding the capability', () => {
    const guard = new CapabilityGuard()
    guard.declareServiceCapability('db.service', 'db.write')
    guard.registerPermissions(perms('com.rem2.writer', ['db.write']))

    expect(() => guard.assert('db.service', 'com.rem2.writer')).not.toThrow()
    expect(guard.deniedTotal).toBe(0)
  })

  it('always allows the kernel itself', () => {
    const guard = new CapabilityGuard()
    guard.declareServiceCapability('db.service', 'db.write')

    expect(() => guard.assert('db.service', 'kernel')).not.toThrow()
  })

  it('re-opens the service once the capability declaration is retracted', () => {
    const guard = new CapabilityGuard()
    guard.declareServiceCapability('db.service', 'db.write')

    guard.retractServiceCapability('db.service')

    expect(() => guard.assert('db.service', 'com.rem2.stranger')).not.toThrow()
  })

  it('denies again after the caller permissions are unregistered', () => {
    const guard = new CapabilityGuard()
    guard.declareServiceCapability('db.service', 'db.write')
    guard.registerPermissions(perms('com.rem2.writer', ['db.write']))

    guard.unregisterPermissions('com.rem2.writer')

    expect(() => guard.assert('db.service', 'com.rem2.writer')).toThrow(
      CapabilityDeniedError,
    )
  })

  it('accumulates the denial counter across services and calls', () => {
    const guard = new CapabilityGuard()
    guard.declareServiceCapability('a.service', 'cap.a')
    guard.declareServiceCapability('b.service', 'cap.b')

    expect(() => guard.assert('a.service', 'com.rem2.x')).toThrow()
    expect(() => guard.assert('b.service', 'com.rem2.x')).toThrow()
    expect(() => guard.assertCapability('cap.c', 'com.rem2.x')).toThrow()

    expect(guard.deniedTotal).toBe(3)
  })
})

describe('capability-guard · imperative checks', () => {
  it('allows the kernel without consulting permissions', () => {
    const guard = new CapabilityGuard()

    expect(() => guard.assertCapability('net.listen', 'kernel')).not.toThrow()
  })

  it('denies a plugin without the capability', () => {
    const guard = new CapabilityGuard()

    expect(() => guard.assertCapability('net.listen', 'com.rem2.a')).toThrow(
      /net\.listen/,
    )
  })

  it('allows a plugin holding the capability', () => {
    const guard = new CapabilityGuard()
    guard.registerPermissions(perms('com.rem2.a', ['net.listen']))

    expect(() =>
      guard.assertCapability('net.listen', 'com.rem2.a'),
    ).not.toThrow()
  })
})
