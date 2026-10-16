/**
 * 权限管理器单测（docs/01：能力 → 授权 → 拦截）。
 */

import { describe, expect, it } from 'vitest';
import { CapabilityGuard } from '../../src/kernel/security/capability-guard.js';
import { PermissionManager } from '../../src/kernel/security/permission-manager.js';
import { CapabilityDeniedError } from '../../src/kernel/errors.js';
import { makeManifest } from '../helpers/make-manifest.js';

describe('permission · 授权判定', () => {
  it('trusted 默认授予常规能力', () => {
    const pm = new PermissionManager();
    const decision = pm.check(
      makeManifest({ id: 'a', requires: ['log.sink', 'command.provide'] }),
      'trusted',
    );
    expect(decision.granted).toContain('log.sink');
    expect(decision.granted).toContain('command.provide');
  });

  it('sandboxed 默认拒绝敏感能力', () => {
    const pm = new PermissionManager();
    const decision = pm.check(
      makeManifest({ id: 'a', requires: ['net.listen', 'fs.write'] }),
      'sandboxed',
    );
    expect(decision.denied).toContain('net.listen');
    expect(decision.denied).toContain('fs.write');
    expect(decision.warnings.length).toBeGreaterThan(0);
  });

  it('sandboxed 默认拒绝未声明于默认集的能力', () => {
    const pm = new PermissionManager();
    const decision = pm.check(
      makeManifest({ id: 'a', requires: ['command.provide'] }),
      'sandboxed',
    );
    expect(decision.denied).toContain('command.provide');
  });

  it('运行期 grant 追加授权', () => {
    const pm = new PermissionManager();
    pm.check(
      makeManifest({ id: 'a', requires: ['net.listen'] }),
      'sandboxed',
    );
    expect(pm.get('a')!.isGranted('net.listen')).toBe(false);
    pm.grant('a', 'net.listen');
    expect(pm.get('a')!.isGranted('net.listen')).toBe(true);
  });
});

describe('permission · CapabilityGuard 拦截', () => {
  it('调用未授权能力抛 CapabilityDeniedError', () => {
    const guard = new CapabilityGuard();
    const pm = new PermissionManager(guard);
    pm.check(
      makeManifest({ id: 'a', requires: ['net.listen'] }),
      'sandboxed',
    );

    guard.declareServiceCapability('svc.x', 'net.listen');
    expect(() => guard.assert('svc.x', 'a')).toThrow(CapabilityDeniedError);
  });

  it('已授权能力通过', () => {
    const guard = new CapabilityGuard();
    const pm = new PermissionManager(guard);
    pm.check(makeManifest({ id: 'a', requires: ['log.sink'] }), 'trusted');
    guard.declareServiceCapability('svc.log', 'log.sink');
    expect(() => guard.assert('svc.log', 'a')).not.toThrow();
  });

  it('未声明能力的服务对任何人开放', () => {
    const guard = new CapabilityGuard();
    expect(() => guard.assert('svc.public', 'anyone')).not.toThrow();
  });

  it('内核自身总是允许', () => {
    const guard = new CapabilityGuard();
    guard.declareServiceCapability('svc.x', 'net.listen');
    expect(() => guard.assert('svc.x', 'kernel')).not.toThrow();
  });

  it('被拒绝次数被记录', () => {
    const guard = new CapabilityGuard();
    guard.declareServiceCapability('svc.x', 'net.listen');
    try {
      guard.assert('svc.x', 'evil');
    } catch {
      /* expected */
    }
    expect(guard.deniedTotal).toBe(1);
  });
});
