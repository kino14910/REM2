/**
 * config-json plugin -- the config source is a plugin.
 *
 * The kernel only defines the `ConfigProvider` contract; this plugin
 * implements reading config from a JSON file and contributes that layer
 * via the `config.provider` extension point.
 */

import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { definePlugin, defineToken, KernelTokens } from 'rem2-kernel'
import type { ConfigProvider, PluginContext, Unsubscribe } from 'rem2-kernel'

/** Minimal structural type for the kernel ConfigService. */
export interface ConfigServiceLike {
  registerProvider(provider: ConfigProvider): void
  unregisterProvider(name: string): void
  refresh(): Promise<void>
  onDidChange(cb: (keys: string[], key: string) => void): Unsubscribe
}

/** Token with the same id as the kernel KernelTokens.ConfigService. */
export const ConfigServiceToken = defineToken<ConfigServiceLike>({
  id: KernelTokens.ConfigService.id,
  describe: 'Kernel config service',
})

class JsonConfigProvider implements ConfigProvider {
  readonly name = 'json'
  readonly priority = 10

  constructor(private readonly filePath: string) {}

  async load(): Promise<Record<string, unknown>> {
    try {
      const text = await readFile(this.filePath, 'utf8')
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      // Missing or unparsable file -> return an empty layer (does not block startup).
      return {}
    }
  }

  async reload(): Promise<Record<string, unknown>> {
    return await this.load()
  }
}

export default definePlugin(
  {
    id: 'com.rem2.config-json',
    name: 'JSON Config Provider',
    version: '1.0.0',
  },
  (ctx: PluginContext) => {
    let filePath = ''
    let configService: ConfigServiceLike | null = null

    return {
      async onConfigure(): Promise<void> {
        // The file path may be set via plugin config; by default use configPath from kernel options, then the built-in default.
        const configured = ctx.config.get<string>('config.json.path')
        filePath = ctx.resolvePath(
          configured ??
            ctx.config.get<string>('config.path') ??
            'config/app.config.json',
        )
      },

      async onStart(): Promise<void> {
        const svc = ctx.services.tryResolve(ConfigServiceToken)
        if (!svc) {
          ctx.log.warn(
            'Kernel ConfigService not found; config-json entering degraded mode',
          )
          return
        }
        configService = svc
        svc.registerProvider(new JsonConfigProvider(filePath))
        await svc.refresh()
        ctx.log.info(`JSON config source registered (${filePath})`)
        void process
      },

      async onStop(hookCtx: PluginContext, reason: string): Promise<void> {
        if (configService) {
          configService.unregisterProvider('json')
        }
        configService = null
        hookCtx.log.info(`JSON config source unregistered (${reason})`)
      },
    }
  },
)
