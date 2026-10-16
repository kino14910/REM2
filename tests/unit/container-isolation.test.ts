/**
 * 边界单测 · 容器可见性（docs/01）。
 *
 * 覆盖架构承诺：
 * - 插件子容器不通过公开属性暴露父容器引用。
 * - 父容器解析不到子容器「未导出」的服务。
 * - 子容器导出 + 反向挂载后，父容器（进而兄弟插件）可解析该服务。
 */

import { describe, expect, it } from 'vitest';
import { Container } from '../../src/kernel/di/container.js';
import { defineToken } from '../../src/kernel/contracts/service-token.js';
import { NoProviderError } from '../../src/kernel/errors.js';

interface Svc {
  value: number;
}

const Exported = defineToken<Svc>({
  id: 'qa.svc.exported',
  describe: 'qa exported',
});
const Unexported = defineToken<Svc>({
  id: 'qa.svc.unexported',
  describe: 'qa unexported',
});

function makeRoot(): Container {
  // 内核 root 容器 shareable=true（公共设施对子容器可见）。
  return new Container({ scope: 'root', shareable: true });
}

describe('container-isolation · 父引用不可见', () => {
  it('子容器不通过公开属性暴露父容器引用', () => {
    const root = makeRoot();
    const child = root.createChild('plugin:a');
    const raw = child as unknown as Record<string, unknown>;

    expect(raw.parent).toBeUndefined();
    expect(raw.parentContainer).toBeUndefined();
    expect(raw.parentRef).toBeUndefined();
    // 仅暴露布尔判定。
    expect(child.hasParent).toBe(true);
    expect(typeof child.hasParent).toBe('boolean');
  });
});

describe('container-isolation · 导出可见性', () => {
  it('父容器解析不到子容器未导出的服务', () => {
    const root = makeRoot();
    const child = root.createChild('plugin:a');
    child.registerInstance(Unexported, { value: 1 });

    expect(() => root.resolve(Unexported)).toThrow(NoProviderError);
  });

  it('导出并反向挂载后，父容器可解析子容器服务', () => {
    const root = makeRoot();
    const child = root.createChild('plugin:a');
    child.registerInstance(Exported, { value: 7 });
    child.markExported(Exported);
    root.mountChildContainer(child); // 等价于 api.export() 的反向挂载

    expect(root.resolve(Exported).value).toBe(7);
  });

  it('取消导出后父容器不再解析该服务', () => {
    const root = makeRoot();
    const child = root.createChild('plugin:a');
    child.registerInstance(Exported, { value: 7 });
    child.markExported(Exported);
    root.mountChildContainer(child);
    expect(root.resolve(Exported).value).toBe(7);

    child.markUnexported(Exported);
    root.unmountChildContainer(child);
    expect(() => root.resolve(Exported)).toThrow(NoProviderError);
  });

  it('插件子容器无法解析父容器未共享且未导出的服务', () => {
    const root = new Container({ scope: 'root', shareable: false });
    root.registerInstance(Unexported, { value: 1 });
    const child = new Container({
      scope: 'plugin:a',
      parent: root,
      pluginScope: true,
    });
    expect(() => child.resolve(Unexported)).toThrow(NoProviderError);
  });
});

describe('container-isolation · 兄弟插件导出（useCapability 底层前提）', () => {
  it('兄弟插件经 root 导出后，其子容器应能解析到该服务', () => {
    const root = makeRoot();
    const provider = root.createChild('plugin:provider');
    const consumer = root.createChild('plugin:consumer');

    provider.registerInstance(Exported, { value: 9 });
    provider.markExported(Exported);
    root.mountChildContainer(provider); // api.export() 的反向挂载

    // 设计承诺（docs/01）：插件可解析「其他插件导出」的服务。
    expect(consumer.resolve(Exported).value).toBe(9);
  });
});
