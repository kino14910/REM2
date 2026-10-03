/**
 * 生命周期管理器单测（7 阶段 + 超时 + 回滚 + 错误隔离，docs/02 §C.1）。
 */

import { describe, expect, it } from 'vitest';
import { LifecycleManager } from '../../src/kernel/lifecycle/lifecycle-manager.js';
import { isLegalTransition } from '../../src/kernel/lifecycle/phases.js';
import { makePlugin } from '../helpers/make-plugin.js';

/** 构造一个可用于 LifecycleManager 的最小 PluginContext 替身。 */
function stubContext(pluginId: string): import('rem2-kernel').PluginContext {
  return {
    pluginId,
    manifest: { id: pluginId } as never,
    container: {} as never,
    services: {} as never,
    events: {} as never,
    config: {
      get: (_k: string, d?: unknown) => d,
      has: () => false,
      getOrThrow: () => undefined,
      onDidChange: () => () => undefined,
    } as never,
    log: {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      fatal: () => undefined,
    },
    metrics: {} as never,
    permissions: {
      pluginId,
      granted: [],
      denied: [],
      isGranted: () => true,
    } as never,
    api: {} as never,
    phase: 'Discover',
    plugins: {
      has: () => false,
      isStarted: () => false,
      get: () => undefined,
      all: () => [],
      byState: () => [],
    },
    resolvePath: (p: string) => p,
  };
}

describe('lifecycle · 阶段序列', () => {
  it('正常启动按 Discover→Load→Initialize→Start 执行', async () => {
    const log: Array<{ hook: string; phase: string }> = [];
    const plugin = makePlugin({ id: 'a', log });
    const mgr = new LifecycleManager({
      startTimeoutMs: 1000,
      stopTimeoutMs: 1000,
    });
    const outcome = await mgr.runStartSequence(plugin, stubContext('a'));
    expect(outcome.ok).toBe(true);
    expect(log.map((l) => l.hook)).toEqual([
      'onDiscover',
      'onLoad',
      'onConfigure',
      'onStart',
    ]);
  });

  it('停止按 Stop→Unload→Dispose 执行', async () => {
    const log: Array<{ hook: string; phase: string }> = [];
    const plugin = makePlugin({ id: 'a', log });
    const mgr = new LifecycleManager({
      startTimeoutMs: 1000,
      stopTimeoutMs: 1000,
    });
    await mgr.runStartSequence(plugin, stubContext('a'));
    await mgr.runStopSequence(plugin, stubContext('a'), 'shutdown');
    const hooks = log.map((l) => l.hook);
    expect(hooks).toContain('onStop');
    expect(hooks).toContain('onUnload');
    expect(hooks).toContain('onDispose');
    expect(hooks.indexOf('onStop')).toBeLessThan(hooks.indexOf('onDispose'));
  });

  it('onStart 抛错时回滚（Dispose/Unload 被调用）', async () => {
    const log: Array<{ hook: string; phase: string }> = [];
    const plugin = makePlugin({ id: 'a', startBehavior: 'throw', log });
    const mgr = new LifecycleManager({
      startTimeoutMs: 1000,
      stopTimeoutMs: 1000,
    });
    const outcome = await mgr.runStartSequence(plugin, stubContext('a'));
    expect(outcome.ok).toBe(false);
    expect(outcome.rolledBack).toBe(true);
    const hooks = log.map((l) => l.hook);
    expect(hooks).toContain('onStop');
    expect(hooks).toContain('onUnload');
  });

  it('onStart 超时被强制中断', async () => {
    const log: Array<{ hook: string; phase: string }> = [];
    const plugin = makePlugin({
      id: 'slow',
      startBehavior: { delayMs: 500 },
      log,
    });
    const mgr = new LifecycleManager({
      startTimeoutMs: 30,
      stopTimeoutMs: 1000,
    });
    const outcome = await mgr.runStartSequence(plugin, stubContext('slow'));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/超时/);
  });

  it('缺失钩子视为成功', async () => {
    const plugin = {
      manifest: { id: 'min' } as never,
      onStart: async (): Promise<void> => undefined,
    };
    const mgr = new LifecycleManager({
      startTimeoutMs: 1000,
      stopTimeoutMs: 1000,
    });
    const outcome = await mgr.runStartSequence(
      plugin as never,
      stubContext('min'),
    );
    expect(outcome.ok).toBe(true);
  });
});

describe('lifecycle · 阶段跃迁合法性', () => {
  it('允许顺序前进', () => {
    expect(isLegalTransition('Discover', 'Load')).toBe(true);
    expect(isLegalTransition('Load', 'Initialize')).toBe(true);
    expect(isLegalTransition('Initialize', 'Start')).toBe(true);
  });

  it('禁止回退', () => {
    expect(isLegalTransition('Start', 'Load')).toBe(false);
  });

  it('任意阶段可进入 Degraded', () => {
    expect(isLegalTransition('Start', 'Degraded')).toBe(true);
  });
});
