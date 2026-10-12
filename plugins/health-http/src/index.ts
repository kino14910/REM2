/**
 * health-http 插件 —— 运维接口是插件。
 *
 * - 提供 `health.expose` + `net.listen`：把内核 HealthService 暴露为 HTTP /health。
 * - **硬依赖** logger-console：证明硬依赖会参与拓扑排序（logger-console 先启动）。
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { definePlugin, defineToken, KernelTokens } from 'rem2-kernel';
import type { HealthReport, PluginContext } from 'rem2-kernel';

/** 对内核 HealthService 的最小结构类型。 */
export interface HealthServiceLike {
  report(): Promise<HealthReport>;
}

/** 与内核 KernelTokens.Health 相同 id 的令牌。 */
export const HealthServiceToken = defineToken<HealthServiceLike>({
  id: KernelTokens.Health.id,
  describe: '内核健康服务',
});

export default definePlugin(
  { id: 'com.rem2.health-http', name: 'Health HTTP Endpoint', version: '1.0.0' },
  (ctx: PluginContext) => {
    let server: Server | null = null;
    let health: HealthServiceLike | null = null;
    let port = 0;

    async function handle(
      req: IncomingMessage,
      res: ServerResponse,
    ): Promise<void> {
      if (req.url === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        try {
          const report = await health!.report();
          const body = JSON.stringify(report, null, 2);
          res.writeHead(report.status === 'healthy' ? 200 : 503, {
            'content-type': 'application/json; charset=utf-8',
          });
          res.end(req.method === 'HEAD' ? undefined : body);
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ status: 'unhealthy', error: (error as Error).message }),
          );
        }
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
    }

    return {
      async onConfigure(): Promise<void> {
        // 端口可配置：0 表示随机。
        port = ctx.config.get<number>('health.http.port', 0);
      },

      async onStart(): Promise<void> {
        const svc = ctx.services.tryResolve(HealthServiceToken);
        if (!svc) {
          throw new Error('health-http 无法解析内核 HealthService');
        }
        health = svc;

        server = createServer((req: IncomingMessage, res: ServerResponse) => {
          void handle(req, res);
        });
        await new Promise<void>((resolve, reject) => {
          server!.once('error', reject);
          server!.listen(port, '127.0.0.1', () => {
            const addr = server!.address() as AddressInfo | null;
            if (addr) port = addr.port;
            resolve();
          });
        });

        ctx.log.info(`健康检查端点监听于 http://127.0.0.1:${port}/health`);
      },

      async onStop(hookCtx: PluginContext, reason: string): Promise<void> {
        const s = server;
        server = null;
        health = null;
        if (s) {
          await new Promise<void>((resolve) => {
            s.close(() => resolve());
          });
        }
        hookCtx.log.info(`健康检查端点已关闭（${reason}）`);
      },

      /** 当前监听端口（测试用）。 */
      getPort(): number {
        return port;
      },
    };
  },
);
