/**
 * 配置服务单测（provider 分层合并 + 变更通知，docs/01）。
 */

import { describe, expect, it } from 'vitest';
import { ConfigService } from '../../src/kernel/config/config-service.js';
import { MemoryConfigProvider } from '../../src/kernel/config/memory-provider.js';
import type { ConfigProvider } from '../../src/kernel/contracts/config.js';

describe('config-service · 分层合并', () => {
  it('高优先级覆盖低优先级', async () => {
    const svc = new ConfigService();
    svc.registerProvider(new MemoryConfigProvider({ a: 1, b: 1 }, 'low', 10));
    svc.registerProvider(new MemoryConfigProvider({ b: 2 }, 'high', 100));
    await svc.refresh();

    expect(svc.get('a')).toBe(1);
    expect(svc.get('b')).toBe(2);
  });

  it('deep merge 对象', async () => {
    const svc = new ConfigService();
    svc.registerProvider(
      new MemoryConfigProvider({ app: { a: 1, b: 2 } }, 'low', 10),
    );
    svc.registerProvider(
      new MemoryConfigProvider({ app: { b: 3 } }, 'high', 100),
    );
    await svc.refresh();

    expect(svc.get('app.a')).toBe(1);
    expect(svc.get('app.b')).toBe(3);
  });

  it('get 支持路径与默认值', async () => {
    const svc = new ConfigService();
    svc.registerProvider(
      new MemoryConfigProvider({ app: { greeting: 'hi' } }, 'm', 10),
    );
    await svc.refresh();

    expect(svc.get('app.greeting')).toBe('hi');
    expect(svc.get<string>('app.missing', 'default')).toBe('default');
    expect(svc.has('app.greeting')).toBe(true);
    expect(svc.has('nope')).toBe(false);
  });

  it('getOrThrow 缺失抛错', async () => {
    const svc = new ConfigService();
    await svc.refresh();
    expect(() => svc.getOrThrow('missing')).toThrow(/缺失/);
  });

  it('layers 按优先级升序', () => {
    const svc = new ConfigService();
    svc.registerProvider(new MemoryConfigProvider({}, 'high', 100));
    svc.registerProvider(new MemoryConfigProvider({}, 'low', 10));
    expect(svc.layers()).toEqual(['low', 'high']);
  });

  it('单 provider 加载失败不影响其他层', async () => {
    const svc = new ConfigService();
    const broken: ConfigProvider = {
      name: 'broken',
      priority: 50,
      load: async () => {
        throw new Error('boom');
      },
    };
    svc.registerProvider(new MemoryConfigProvider({ ok: true }, 'good', 10));
    svc.registerProvider(broken);
    await svc.refresh();
    expect(svc.get('ok')).toBe(true);
  });
});

describe('config-service · 变更通知', () => {
  it('set 后触发 onDidChange', async () => {
    const svc = new ConfigService();
    svc.registerProvider(new MemoryConfigProvider({}, 'memory', 1000));
    await svc.refresh();

    let changedKey = '';
    svc.onDidChange((_keys, key) => {
      changedKey = key;
    });
    await svc.set('foo', 'bar');
    expect(changedKey).toBe('foo');
    expect(svc.get('foo')).toBe('bar');
  });

  it('provider.onDidChange 触发内核刷新', async () => {
    const svc = new ConfigService();
    let notify: ((keys: string[]) => void) | null = null;
    const provider: ConfigProvider = {
      name: 'watch',
      priority: 10,
      load: async () => ({ watched: Date.now() }),
      onDidChange: (cb) => {
        notify = cb;
        return () => {
          notify = null;
        };
      },
    };
    svc.registerProvider(provider);
    await svc.refresh();
    expect(notify).not.toBeNull();

    const before = svc.get<number>('watched');
    // 触发变更 → 标记 dirty（需再次 refresh 才更新快照）
    notify!(['watched']);
    await svc.refresh();
    expect(svc.get<number>('watched')).toBeGreaterThanOrEqual(before);
  });
});
