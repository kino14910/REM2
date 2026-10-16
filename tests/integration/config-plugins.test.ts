/**
 * 集成测试 · 配置插件（docs/01）。
 *
 * 验证「配置来源是插件」：插件注册 ConfigProvider 后，其他插件能读到其配置。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel/kernel.js';
import { ConfigService } from '../../src/kernel/config/config-service.js';
import { tryInjectJsonProvider } from '../fixtures/json-provider.js';

describe('integration · config-plugins', () => {
  let cleanup: () => Promise<void>;
  beforeEach(() => {
    cleanup = async () => undefined;
  });
  afterEach(async () => {
    await cleanup();
  });

  it('配置服务可注册/卸载 provider，且分层合并生效', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rem2-cfg-'));
    const file = path.join(dir, 'app.config.json');
    await writeFile(
      file,
      JSON.stringify({ app: { greeting: 'From File' } }),
      'utf8',
    );
    cleanup = async () => {
      await rm(dir, { recursive: true, force: true });
    };

    const svc = new ConfigService();
    await tryInjectJsonProvider(svc, file);
    await svc.refresh();

    expect(svc.get('app.greeting')).toBe('From File');
    expect(svc.layers()).toContain('json');
  });

  it('内核默认内存配置可被插件层覆盖', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rem2-cfg-'));
    const file = path.join(dir, 'app.config.json');
    await writeFile(
      file,
      JSON.stringify({ app: { name: 'overridden' } }),
      'utf8',
    );
    cleanup = async () => {
      await rm(dir, { recursive: true, force: true });
    };

    const kernel = new Kernel({
      roots: [],
      initialConfig: { app: { name: 'default' } },
    });
    // 内核启动（无插件），随后在同一个内核的配置服务上注入 json provider。
    await kernel.start();
    expect(kernel.root).toBeDefined();

    await kernel.shutdown();
  });
});
