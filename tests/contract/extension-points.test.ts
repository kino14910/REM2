/**
 * 契约测试：扩展点清单一致性（PRD A7）。
 *
 * 断言 `src/kernel/extensions/definitions.ts` 的导出 id 与 `docs/03 §7.2` 的
 * 「扩展点全表」**逐 id 一一对应**。这条约束若不机器化，文档与代码必然漂移 ——
 * 而「扩展点清单」正是 P3「一切皆插件」的骨架。
 *
 * 期望值以字面量数组写死（而非 import 自另一处），这样它才是**独立判据**：
 * 若 definitions.ts 与本表同时被改错，测试仍然会红。
 */

import { describe, expect, it } from 'vitest';
import {
  EXTENSION_POINT_DEFS,
  EXTENSION_POINT_IDS,
} from '../../src/kernel/extensions/definitions.js';
import type { ExtensionPointDef } from '../../src/kernel/contracts/extension-point.js';

type AnyDef = ExtensionPointDef<unknown>;

/** docs/03 §7.2 扩展点全表（有序，12 条）。 */
const EXPECTED_IDS = [
  'log.sink',
  'metrics.sink',
  'trace.exporter',
  'config.provider',
  'command.provide',
  'health.check',
  'ui.theme',
  'ui.panel',
  'ui.route',
  'scheduler.replace',
  'resolver.replace',
  'loader.replace',
] as const;

describe('contract · 扩展点清单与 docs/03 §7.2 一致', () => {
  it('导出的扩展点 id 与文档全表逐条一致（有序）', () => {
    expect(EXTENSION_POINT_IDS).toEqual(EXPECTED_IDS);
  });

  it('id 无重复', () => {
    expect(new Set(EXTENSION_POINT_IDS).size).toBe(EXTENSION_POINT_IDS.length);
  });

  it('每条定义都有 describe，且单例槽必须显式声明冲突裁决策略', () => {
    for (const def of EXTENSION_POINT_DEFS) {
      expect(def.describe.length).toBeGreaterThan(0);
      if (!def.multi) {
        // 单例槽不允许隐式默认：三个策略中必须显式命中一个。
        expect(['reject-new', 'replace-old', 'keep-first']).toContain(def.conflict);
      }
    }
  });

  it('UI 类扩展点齐备（ui.theme / ui.panel / ui.route）', () => {
    // 这三条是 Svelte 前端插槽的挂载面，缺一条前端就没有通用渲染入口。
    for (const id of ['ui.theme', 'ui.panel', 'ui.route']) {
      expect(EXTENSION_POINT_IDS).toContain(id);
    }
  });

  it('ui.panel 是 multi 槽且同 id 冲突 reject-new；ui.route 是 multi 槽且 replace-old', () => {
    const panel = EXTENSION_POINT_DEFS.find((d) => d.id === 'ui.panel');
    expect(panel).toBeDefined();
    expect(panel?.multi).toBe(true);
    expect(panel?.conflict).toBe('reject-new');

    const route = EXTENSION_POINT_DEFS.find((d) => d.id === 'ui.route');
    expect(route).toBeDefined();
    expect(route?.multi).toBe(true);
    expect(route?.conflict).toBe('replace-old');
  });

  it('ui.theme 是单例槽且 keep-first（首个生效，后续被拒并记 issue）', () => {
    const theme = EXTENSION_POINT_DEFS.find((d) => d.id === 'ui.theme');
    expect(theme?.multi).toBe(false);
    expect(theme?.conflict).toBe('keep-first');
  });

  it('三个 *.replace 扩展点均为单例 + replace-old + kernel.internals 门槛', () => {
    for (const id of ['scheduler.replace', 'resolver.replace', 'loader.replace']) {
      const def = EXTENSION_POINT_DEFS.find((d) => d.id === id);
      expect(def).toBeDefined();
      expect(def?.multi).toBe(false);
      expect(def?.conflict).toBe('replace-old');
      // capability 是可选字段，`as const` 会把「某些 def 没有它」体现为联合类型，
      // 因此这里显式收窄为 ExtensionPointDef 再读。
      expect((def as AnyDef | undefined)?.capability).toBe(
        'kernel.internals',
      );
    }
  });
});
