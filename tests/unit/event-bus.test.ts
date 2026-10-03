import { describe, expect, it, vi } from 'vitest';
import { EventBusImpl } from '../../src/kernel/events/event-bus.js';
import { matches } from '../../src/kernel/events/pattern.js';
import { Priority, compareHandlers } from '../../src/kernel/events/priority.js';
import { NoResponderError, TimeoutError } from '../../src/kernel/errors.js';

describe('events · 通配符匹配', () => {
  it('精确匹配', () => {
    expect(matches('command:execute', 'command:execute')).toBe(true);
    expect(matches('command:execute', 'command:other')).toBe(false);
  });

  it('单星匹配单段', () => {
    expect(matches('command:*', 'command:execute')).toBe(true);
    expect(matches('command:*', 'command:execute:sub')).toBe(false);
  });

  it('双星匹配多段', () => {
    expect(matches('command:**', 'command:execute:sub')).toBe(true);
    expect(matches('kernel.**', 'kernel.plugin.started')).toBe(true);
  });

  it('全局 * 匹配一切', () => {
    expect(matches('*', 'anything:at:all')).toBe(true);
  });

  it('点号分隔也生效', () => {
    expect(matches('app.*', 'app.config')).toBe(true);
  });
});

describe('events · 优先级排序', () => {
  it('数值大者优先，同级按 seq 升序', () => {
    const list = [
      { priority: 0, seq: 1, id: 'c' },
      { priority: 10, seq: 2, id: 'a' },
      { priority: 0, seq: 0, id: 'b' },
    ];
    list.sort(compareHandlers);
    expect(list.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('预置优先级常量有序', () => {
    expect(Priority.Highest).toBeGreaterThan(Priority.Normal);
    expect(Priority.Normal).toBeGreaterThan(Priority.Low);
  });
});

describe('events · EventBus', () => {
  it('emit 顺序派发所有匹配订阅者', async () => {
    const bus = new EventBusImpl();
    const calls: string[] = [];
    bus.on('command:*', () => {
      calls.push('a');
    });
    bus.on('command:execute', () => {
      calls.push('b');
    });
    await bus.emit('command:execute');
    expect(calls).toEqual(['a', 'b']);
  });

  it('优先级决定执行顺序', async () => {
    const bus = new EventBusImpl();
    const calls: string[] = [];
    bus.on(
      'e',
      () => {
        calls.push('low');
      },
      { priority: Priority.Low },
    );
    bus.on(
      'e',
      () => {
        calls.push('high');
      },
      { priority: Priority.High },
    );
    bus.on('e', () => {
      calls.push('normal');
    });
    await bus.emit('e');
    expect(calls).toEqual(['high', 'normal', 'low']);
  });

  it('订阅者抛错不影响其他订阅者与发布者（错误隔离）', async () => {
    const bus = new EventBusImpl();
    const calls: string[] = [];
    bus.on('e', () => {
      throw new Error('boom');
    });
    bus.on('e', () => {
      calls.push('after');
    });
    await expect(bus.emit('e')).resolves.toBeUndefined();
    expect(calls).toEqual(['after']);
  });

  it('异步订阅者抛错同样被隔离', async () => {
    const bus = new EventBusImpl();
    const calls: string[] = [];
    bus.on('e', async () => {
      throw new Error('async boom');
    });
    bus.on('e', async () => {
      calls.push('ok');
    });
    await bus.emit('e');
    expect(calls).toEqual(['ok']);
  });

  it('onHandlerError 回调被触发', async () => {
    const onHandlerError = vi.fn();
    const bus = new EventBusImpl({ onHandlerError });
    bus.on('e', () => {
      throw new Error('boom');
    });
    await bus.emit('e');
    expect(onHandlerError).toHaveBeenCalledTimes(1);
  });

  it('once 只执行一次', async () => {
    const bus = new EventBusImpl();
    let count = 0;
    bus.once('e', () => {
      count += 1;
    });
    await bus.emit('e');
    await bus.emit('e');
    expect(count).toBe(1);
  });

  it('off 取消订阅', async () => {
    const bus = new EventBusImpl();
    let count = 0;
    const handler = () => {
      count += 1;
    };
    const unsub = bus.on('e', handler);
    await bus.emit('e');
    unsub();
    await bus.emit('e');
    expect(count).toBe(1);
  });

  it('request/respond RPC 工作正常', async () => {
    const bus = new EventBusImpl();
    bus.respond('sum', (payload) => {
      const { a, b } = payload as { a: number; b: number };
      return a + b;
    });
    await expect(bus.request('sum', { a: 2, b: 3 })).resolves.toBe(5);
  });

  it('request 无响应者抛 NoResponderError', async () => {
    const bus = new EventBusImpl();
    await expect(bus.request('nope')).rejects.toThrow(NoResponderError);
  });

  it('request 超时抛 TimeoutError', async () => {
    const bus = new EventBusImpl();
    bus.respond(
      'slow',
      () => new Promise((resolve) => setTimeout(resolve, 1000)),
    );
    await expect(
      bus.request('slow', undefined, { timeoutMs: 10 }),
    ).rejects.toThrow(TimeoutError);
  });

  it('matching 暴露匹配判断', () => {
    const bus = new EventBusImpl();
    expect(bus.matching('a.*', 'a.b')).toBe(true);
  });

  it('clear 清空全部订阅', async () => {
    const bus = new EventBusImpl();
    bus.on('e', () => undefined);
    expect(bus.size()).toBe(1);
    bus.clear();
    expect(bus.size()).toBe(0);
  });
});
