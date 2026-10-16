/**
 * 集成测试 · 主题链路（扩展点槽 → 宿主 → renderer 数据源）。
 *
 * ★ 为什么需要这条（曾真实断裂）：
 * `theme-dark` 把主题贡献进 `ui.theme` 扩展点单例槽，但宿主的
 * `ui.theme.list` responder 读的是一块**独立内存**（ThemeRegistryImpl）。
 * 两侧之间没有任何代码连通 —— 主题数据进了扩展点就断了，
 * `ui.theme.list` 恒返回 []、`ui.theme.set` 恒失败，前端永远拿不到主题。
 * 这是「生产者注册了、消费者没接」的第四例。
 *
 * 本用例直接驱动内核 + 扩展点，断言槽里确有贡献且可被读出；
 * 宿主侧的 pull 同步逻辑由 `main.ts` 的 `syncThemeFromExtension` 承担，
 * 其行为在此以同样的语义复刻验证（含卸载后自动失效）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel/kernel.js';
import { createDeps } from '../../src/kernel/composition.js';
import { KernelTokens } from '../../src/kernel/contracts/kernel-tokens.js';
import type { EventBus } from '../../src/kernel/contracts/event-bus.js';
import type { ThemeDefinition } from '../../src/kernel/contracts/ui.js';
import { ThemeRegistryImpl } from '../../src/host/electron/theme-registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const BUILTIN_ROOT = path.join(PROJECT_ROOT, 'plugins-dist');

function createKernel(): Kernel {
  return new Kernel(
    createDeps({
      id: 'rem2-theme-chain',
      roots: [],
      builtinRoot: BUILTIN_ROOT,
      startTimeoutMs: 8000,
      stopTimeoutMs: 8000,
      legacyFallback: false,
      logLevel: 'error',
    }),
  );
}

describe('integration · 主题链路', () => {
  it('theme-dark 确实把主题贡献进了 ui.theme 单例槽', async () => {
    const kernel = createKernel();
    try {
      await kernel.start();

      const contributed =
        kernel.extensions.resolveSingle<ThemeDefinition>('ui.theme');
      expect(contributed).toBeDefined();
      expect(contributed?.id).toBe('dark');
      expect(contributed?.colors.background).toBe('#0f1115');
    } finally {
      await kernel.shutdown();
    }
  });

  it('经宿主 pull 同步后，主题注册表能拿到该主题并自动激活', async () => {
    const kernel = createKernel();
    try {
      await kernel.start();
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus);
      const registry = new ThemeRegistryImpl();

      // 与 main.ts 的 syncThemeFromExtension 同语义：扩展点槽是单一真相源，
      // 注册表退化为缓存；插件卸载时内核按 pluginId 强制回收（P6），
      // 下一次 pull 自然同步为空。
      const sync = (): void => {
        const contributed =
          kernel.extensions.resolveSingle<ThemeDefinition>('ui.theme');
        for (const t of registry.list()) {
          if (!contributed || t.id !== contributed.id)
            registry.unregister(t.id);
        }
        if (contributed && !registry.get(contributed.id)) {
          registry.register(contributed);
          registry.activate(contributed.id);
        }
      };

      bus.respond('ui.theme.list', () => {
        sync();
        return registry.list();
      });
      bus.respond<{ themeId: string }, { ok: boolean }>(
        'ui.theme.set',
        (args) => {
          sync();
          return { ok: registry.activate(String(args?.themeId ?? '')) };
        },
      );

      // 修复前的语义：不 pull 就是空的（这条断言记录缺陷本身）
      expect(registry.list()).toEqual([]);

      const list = await bus.request<undefined, ThemeDefinition[]>(
        'ui.theme.list',
        undefined,
        {
          timeoutMs: 5000,
        },
      );
      expect(list.length).toBe(1);
      expect(list[0]!.id).toBe('dark');

      expect(registry.active()).toBe('dark');

      const set = await bus.request<{ themeId: string }, { ok: boolean }>(
        'ui.theme.set',
        { themeId: 'dark' },
        { timeoutMs: 5000 },
      );
      expect(set.ok).toBe(true);
    } finally {
      await kernel.shutdown();
    }
  });

  it('卸载 theme-dark 后主题自动失效（pull 模型，无需监听 unload）', async () => {
    const kernel = createKernel();
    try {
      await kernel.start();
      const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus);
      const registry = new ThemeRegistryImpl();

      const sync = (): void => {
        const contributed =
          kernel.extensions.resolveSingle<ThemeDefinition>('ui.theme');
        for (const t of registry.list()) {
          if (!contributed || t.id !== contributed.id)
            registry.unregister(t.id);
        }
        if (contributed && !registry.get(contributed.id)) {
          registry.register(contributed);
          registry.activate(contributed.id);
        }
      };

      bus.respond('ui.theme.list', () => {
        sync();
        return registry.list();
      });

      const before = await bus.request<undefined, ThemeDefinition[]>(
        'ui.theme.list',
        undefined,
        {
          timeoutMs: 5000,
        },
      );
      expect(before.length).toBe(1);

      await kernel.unloadPlugin('com.rem2.theme-dark');

      const after = await bus.request<undefined, ThemeDefinition[]>(
        'ui.theme.list',
        undefined,
        {
          timeoutMs: 5000,
        },
      );
      expect(after).toEqual([]);
      expect(registry.active()).toBeUndefined();
    } finally {
      await kernel.shutdown();
    }
  });
});
