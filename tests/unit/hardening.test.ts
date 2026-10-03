/**
 * 单测 · 加固回归（QA 复核发现的问题的回归保护）。
 *
 * 这三条都是「承诺成立、但实现有缺口」的类型，且**原先无测试覆盖**：
 *
 * 1. `ConfigService.refresh()` 曾用裸 `catch {}` 吞掉 provider 加载失败
 *    —— 与项目「绝不静默降级」的原则冲突（对照基线正是静默失败的反面教材）。
 * 2. 全硬边环的节点会从 `loadOrder` 中消失，却不出现在 `plan.dropped`
 *    —— 观测不一致：插件"凭空消失"。
 * 3. `ID_RE` 曾放行 `bad..id` 这类含连续分隔符的非法 id。
 */

import { describe, expect, it } from 'vitest';
import { ConfigService } from '../../src/kernel/config/config-service.js';
import type { ConfigProviderFailure } from '../../src/kernel/config/config-service.js';
import type { ConfigProvider } from '../../src/kernel/contracts/config.js';
import { DependencyResolver } from '../../src/kernel/dependency/resolver.js';
import { validateManifest } from '../../src/kernel/discovery/manifest-validator.js';
import { makeCandidate, makeManifest } from '../helpers/make-manifest.js';

// ─────────────────────────── 1. 配置 provider 失败必须可观测 ───────────────────────────

describe('hardening · ConfigService provider 失败不静默', () => {
  /** 永远抛错的 provider。 */
  function failingProvider(name: string, priority = 10): ConfigProvider {
    return {
      name,
      priority,
      async load(): Promise<Record<string, unknown>> {
        throw new Error(`${name} 读取失败`);
      },
    };
  }

  it('失败的 provider 被记录到 loadFailures，而非静默吞掉', async () => {
    const svc = new ConfigService();
    svc.registerProvider(failingProvider('broken'));

    await svc.refresh();

    expect(svc.loadFailures).toHaveLength(1);
    expect(svc.loadFailures[0]?.provider).toBe('broken');
    expect(svc.loadFailures[0]?.error).toContain('读取失败');
  });

  it('失败会被上报到 onProviderError 回调（可接入日志/指标）', async () => {
    const seen: ConfigProviderFailure[] = [];
    const svc = new ConfigService({ onProviderError: (f) => seen.push(f) });
    svc.registerProvider(failingProvider('broken'));

    await svc.refresh();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.provider).toBe('broken');
  });

  it('单个 provider 失败不阻断其他层（合并仍生效）', async () => {
    const svc = new ConfigService();
    svc.registerProvider(failingProvider('broken', 10));
    svc.registerProvider({
      name: 'ok',
      priority: 20,
      async load() {
        return { app: { name: 'rem2' } };
      },
    });

    await svc.refresh();

    // 好的一层照常生效
    expect(svc.get('app.name')).toBe('rem2');
    // 坏的一层被记录
    expect(svc.loadFailures.map((f) => f.provider)).toEqual(['broken']);
  });

  it('clearLoadFailures 可清空记录', async () => {
    const svc = new ConfigService();
    svc.registerProvider(failingProvider('broken'));
    await svc.refresh();
    expect(svc.loadFailures).toHaveLength(1);

    svc.clearLoadFailures();
    expect(svc.loadFailures).toHaveLength(0);
  });
});

// ─────────────────────────── 2. 环节点必须出现在 dropped ───────────────────────────

describe('hardening · 全硬边环节点必须登记为 dropped', () => {
  const OPTS = { kernelVersion: '1.0.0', contractVersion: '1' } as const;

  it('互为硬依赖的环 → 节点不出现在 loadOrder，但必须出现在 dropped', () => {
    const resolver = new DependencyResolver();
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
    );

    // 环节点不得被加载
    expect(plan.loadOrder).not.toContain('com.qa.cyc-a');
    expect(plan.loadOrder).not.toContain('com.qa.cyc-b');
    // 无关插件照常加载
    expect(plan.loadOrder).toContain('com.qa.solo');

    // 关键断言：环节点必须被明确报告为 dropped（而非凭空消失）
    expect(plan.dropped).toContain('com.qa.cyc-a');
    expect(plan.dropped).toContain('com.qa.cyc-b');

    // 且必须给出可诊断的 E_CYCLE 问题
    const cycleIssues = plan.issues.filter((i) => i.code === 'E_CYCLE');
    expect(cycleIssues.length).toBeGreaterThanOrEqual(2);
    expect(cycleIssues.every((i) => i.level === 'error')).toBe(true);
  });

  it('loadOrder + dropped 覆盖全部输入候选（无节点凭空消失）', () => {
    const resolver = new DependencyResolver();
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
    ];
    const plan = resolver.resolve(candidates, OPTS);

    const accounted = new Set([...plan.loadOrder, ...plan.dropped]);
    for (const c of candidates) {
      expect(accounted.has(c.manifest.id)).toBe(true);
    }
  });
});

// ─────────────────────────── 3. id 校验拒绝连续分隔符 ───────────────────────────

describe('hardening · 插件 id 拒绝连续分隔符', () => {
  function idValid(id: string): boolean {
    const r = validateManifest(makeManifest({ id }));
    return r.ok;
  }

  it('拒绝含连续分隔符的 id', () => {
    expect(idValid('bad..id')).toBe(false);
    expect(idValid('bad--id')).toBe(false);
    expect(idValid('bad__id')).toBe(false);
    expect(idValid('bad.-id')).toBe(false);
  });

  it('拒绝以分隔符开头/结尾的 id', () => {
    expect(idValid('.bad')).toBe(false);
    expect(idValid('bad.')).toBe(false);
    expect(idValid('-bad')).toBe(false);
    expect(idValid('bad-')).toBe(false);
  });

  it('接受合法 id（含 reverse-DNS、连字符、下划线）', () => {
    expect(idValid('com.rem2.hello-command')).toBe(true);
    expect(idValid('com.example.my_plugin')).toBe(true);
    expect(idValid('com.rem2.config-json')).toBe(true);
    expect(idValid('abc')).toBe(true);
  });

  it('拒绝长度小于 3 的 id（既有约束）', () => {
    expect(idValid('a')).toBe(false);
    expect(idValid('ab')).toBe(false);
  });

  it('拒绝大写与空格（原有约束不回归）', () => {
    expect(idValid('Com.Rem2.App')).toBe(false);
    expect(idValid('bad id')).toBe(false);
  });
});
