/**
 * config-json 插件 —— 配置来源是插件。
 *
 * 内核只定义 `ConfigProvider` 契约；本插件实现「从 JSON 文件读取配置」，
 * 并经 `config.provider` 扩展点贡献该层。
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { definePlugin, defineToken, KernelTokens } from 'rem2-kernel';
import type { ConfigProvider, PluginContext, Unsubscribe } from 'rem2-kernel';

/** 对内核 ConfigService 的最小结构类型。 */
export interface ConfigServiceLike {
  registerProvider(provider: ConfigProvider): void;
  unregisterProvider(name: string): void;
  refresh(): Promise<void>;
  onDidChange(cb: (keys: string[], key: string) => void): Unsubscribe;
}

/** 与内核 KernelTokens.ConfigService 相同 id 的令牌。 */
export const ConfigServiceToken = defineToken<ConfigServiceLike>({
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

export default definePlugin(
  {
    id: 'com.rem2.config-json',
    name: 'JSON Config Provider',
    version: '1.0.0',
  },
  (ctx: PluginContext) => {
    let filePath = '';
    let configService: ConfigServiceLike | null = null;

    return {
      async onConfigure(): Promise<void> {
        // 允许通过插件配置指定文件路径；缺省用内核选项中的 configPath，再退回默认。
        const configured = ctx.config.get<string>('config.json.path');
        filePath = ctx.resolvePath(
          configured ??
            ctx.config.get<string>('config.path') ??
            'config/app.config.json',
        );
      },

      async onStart(): Promise<void> {
        const svc = ctx.services.tryResolve(ConfigServiceToken);
        if (!svc) {
          ctx.log.warn('未找到内核 ConfigService，config-json 进入降级');
          return;
        }
        configService = svc;
        svc.registerProvider(new JsonConfigProvider(filePath));
        await svc.refresh();
        ctx.log.info(`JSON 配置源已注册（${filePath}）`);
        void process;
      },

      async onStop(hookCtx: PluginContext, reason: string): Promise<void> {
        if (configService) {
          configService.unregisterProvider('json');
        }
        configService = null;
        hookCtx.log.info(`JSON 配置源已注销（${reason}）`);
      },
    };
  },
);
