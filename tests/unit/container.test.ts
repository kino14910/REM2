import { describe, expect, it } from 'vitest';
import { Container } from '../../src/kernel/di/container.js';
import { ServiceToken } from '../../src/kernel/contracts/service-token.js';
import { Lifetime } from '../../src/kernel/di/lifetime.js';
import {
  CircularDependencyError,
  NoProviderError,
} from '../../src/kernel/errors.js';

interface Greeter {
  greet(name: string): string;
}

const GreeterToken = ServiceToken.create<Greeter>({
  id: 'test.greeter',
  describe: '测试 Greeter',
});

describe('DI · Container', () => {
  it('singleton 只实例化一次', () => {
    const c = new Container({ scope: 'root' });
    let count = 0;
    c.register(
      GreeterToken,
      () => {
        count += 1;
        return { greet: (n: string) => `hi ${n}` };
      },
      Lifetime.Singleton,
    );
    const a = c.resolve(GreeterToken);
    const b = c.resolve(GreeterToken);
    expect(a).toBe(b);
    expect(count).toBe(1);
  });

  it('transient 每次新建', () => {
    const c = new Container({ scope: 'root' });
    let count = 0;
    c.register(
      GreeterToken,
      () => {
        count += 1;
        return { greet: (n: string) => `hi ${n}` };
      },
      Lifetime.Transient,
    );
    c.resolve(GreeterToken);
    c.resolve(GreeterToken);
    expect(count).toBe(2);
  });

  it('registerInstance 直接返回实例', () => {
    const c = new Container({ scope: 'root' });
    const inst: Greeter = { greet: (n) => `hi ${n}` };
    c.registerInstance(GreeterToken, inst);
    expect(c.resolve(GreeterToken)).toBe(inst);
  });

  it('未注册服务抛 NoProviderError', () => {
    const c = new Container({ scope: 'root' });
    expect(() => c.resolve(GreeterToken)).toThrow(NoProviderError);
    expect(c.tryResolve(GreeterToken)).toBeUndefined();
  });

  it('子容器可解析父容器的公共（root shareable）服务', () => {
    const root = new Container({ scope: 'root', shareable: true });
    root.registerInstance(GreeterToken, { greet: (n) => `hi ${n}` });
    const child = root.createChild('plugin:a');
    expect(child.resolve(GreeterToken).greet('x')).toBe('hi x');
  });

  it('插件子容器无法解析父容器未导出的服务', () => {
    const root = new Container({ scope: 'root' });
    root.registerInstance(GreeterToken, { greet: (n) => `hi ${n}` }); // 非 exported，非 shareable
    const child = new Container({
      scope: 'plugin:a',
      parent: root,
      pluginScope: true,
    });
    expect(() => child.resolve(GreeterToken)).toThrow(NoProviderError);
  });

  it('导出后插件子容器可解析到父容器服务', () => {
    const root = new Container({ scope: 'root' });
    root.registerInstance(GreeterToken, { greet: (n) => `hi ${n}` });
    root.markExported(GreeterToken);
    const child = new Container({
      scope: 'plugin:a',
      parent: root,
      pluginScope: true,
    });
    expect(child.resolve(GreeterToken)).toBeDefined();
  });

  it('循环依赖抛 CircularDependencyError', () => {
    const root = new Container({ scope: 'root' });
    const A = ServiceToken.create<unknown>({ id: 'a', describe: 'a' });
    const B = ServiceToken.create<unknown>({ id: 'b', describe: 'b' });
    root.register(A, (c) => (c as Container).resolve(B), Lifetime.Singleton);
    root.register(B, (c) => (c as Container).resolve(A), Lifetime.Singleton);
    expect(() => root.resolve(A)).toThrow(CircularDependencyError);
  });

  it('has / list 行为正确', () => {
    const c = new Container({ scope: 'root' });
    expect(c.has(GreeterToken)).toBe(false);
    c.registerInstance(GreeterToken, { greet: () => 'x' });
    expect(c.has(GreeterToken)).toBe(true);
    expect(c.list()).toContain('test.greeter');
  });

  it('dispose 调用实例的 dispose', () => {
    const c = new Container({ scope: 'root' });
    let disposed = false;
    c.registerInstance(GreeterToken, {
      greet: () => 'x',
      dispose: () => {
        disposed = true;
      },
    } as Greeter & { dispose: () => void });
    c.dispose();
    expect(disposed).toBe(true);
  });

  it('插件不得访问父容器引用（hasParent 只返回布尔）', () => {
    const root = new Container({ scope: 'root' });
    const child = root.createChild('plugin:a');
    expect(child.hasParent).toBe(true);
    // 无公开的 parent 属性
    expect(
      (child as unknown as { parentRef?: unknown }).parentRef,
    ).toBeUndefined();
  });
});
