/**
 * config-json 插件 —— 配置来源是插件（docs/02 §M.2，动机 #10）。
 *
 * 内核只定义 `ConfigProvider` 契约；本插件实现"从 JSON 文件读取配置"。
 * 可被 config-env / config-remote 等同契约 provider 替换。
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { KernelTokens, ServiceToken } from 'rem2-kernel';
import type {
  ConfigProvider,
  Plugin,
  PluginContext,
  PluginManifest,
  Unsubscribe,
} from 'rem2-kernel';

/** 对内核 ConfigService 的最小结构类型。 */
export interface ConfigServiceLike {
  registerProvider(provider: ConfigProvider): void;
  unregisterProvider(name: string): void;
  refresh(): Promise<void>;
  onDidChange(cb: (keys: string[], key: string) => void): Unsubscribe;
}

/** 与内核 KernelTokens.ConfigService 相同 id 的令牌。 */
export const ConfigServiceToken: ServiceToken<ConfigServiceLike> =
  ServiceToken.create<ConfigServiceLike>({
    id: KernelTokens.ConfigService.id,
    describe: '内核配置服务',
  });

/** JSON 文件配置源。 */
class JsonConfigProvider implements ConfigProvider {
  readonly name = 'json';
  readonly priority = 10;

  constructor(private readonly filePath: string) {}

  async load(): Promise<Record<string, unknown>> {
    try {
      const text = await readFile(this.filePath, 'utf8');
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      // 文件缺失/解析失败 → 返回空层（不阻塞启动）。
      return {};
    }
  }

  async reload(): Promise<Record<string, unknown>> {
    return await this.load();
  }
}

/**
 * 插件实现。
 */
export default class ConfigJsonPlugin implements Plugin {
  readonly manifest: PluginManifest = {
    id: 'com.rem2.config-json',
    name: 'JSON Config Provider',
    version: '1.0.0',
    entry: 'src/index.ts',
    capabilities: ['config.provider', 'fs.read'],
    compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
    author: 'rem2-team',
    description: '从 JSON 文件加载配置',
    tags: ['config'],
  };

  private provider: JsonConfigProvider | null = null;
  private configService: ConfigServiceLike | null = null;
  private filePath = '';

  async onConfigure(ctx: PluginContext): Promise<void> {
    // 允许通过插件配置指定文件路径；缺省用内核选项中的 configPath，再退回默认。
    const configured = ctx.config.get<string>('config.json.path');
    const resolved = ctx.resolvePath(
      configured ??
        ctx.config.get<string>('config.path') ??
        'config/app.config.json',
    );
    this.filePath = resolved;
  }

  async onStart(ctx: PluginContext): Promise<void> {
    const svc = ctx.services.tryResolve(ConfigServiceToken);
    if (!svc) {
      ctx.log.warn('未找到内核 ConfigService，config-json 进入降级');
      return;
    }
    this.configService = svc;
    this.provider = new JsonConfigProvider(this.filePath);
    svc.registerProvider(this.provider);
    await svc.refresh();
    ctx.log.info(`JSON 配置源已注册（${this.filePath}）`);
    void process;
  }

  async onStop(ctx: PluginContext, reason: string): Promise<void> {
    if (this.configService && this.provider) {
      this.configService.unregisterProvider(this.provider.name);
    }
    this.provider = null;
    this.configService = null;
    ctx.log.info(`JSON 配置源已注销（${reason}）`);
  }
}
