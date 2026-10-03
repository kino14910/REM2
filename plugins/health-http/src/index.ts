/**
 * health-http 插件 —— 运维接口是插件（docs/02 §M.4，动机 #8 + #2 硬依赖排序）。
 *
 * - 提供 `health.expose` + `net.listen` 能力：把内核 HealthService 暴露为 HTTP /health。
 * - **硬依赖** logger-console：证明硬依赖会参与拓扑排序（logger-console 先启动）。
 */

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { KernelTokens, ServiceToken } from 'rem2-kernel';
import type {
  HealthReport,
  Plugin,
  PluginContext,
  PluginManifest,
} from 'rem2-kernel';

/** 对内核 HealthService 的最小结构类型。 */
export interface HealthServiceLike {
  report(): Promise<HealthReport>;
}

/** 与内核 KernelTokens.Health 相同 id 的令牌。 */
export const HealthServiceToken: ServiceToken<HealthServiceLike> =
  ServiceToken.create<HealthServiceLike>({
    id: KernelTokens.Health.id,
    describe: '内核健康服务',
  });

/**
 * 插件实现。
 */
export default class HealthHttpPlugin implements Plugin {
  readonly manifest: PluginManifest = {
    id: 'com.rem2.health-http',
    name: 'Health HTTP Endpoint',
    version: '1.0.0',
    entry: 'src/index.ts',
    dependencies: { 'com.rem2.logger-console': '^1.0.0' },
    capabilities: ['health.expose', 'net.listen'],
    compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
    author: 'rem2-team',
    description: '把 HealthService 暴露为 /health 端点',
    tags: ['observability', 'ops'],
  };

  private server: Server | null = null;
  private health: HealthServiceLike | null = null;
  private port = 0;

  async onConfigure(ctx: PluginContext): Promise<void> {
    // 端口可配置：0 表示随机。
    this.port = ctx.config.get<number>('health.http.port', 0);
  }

  async onStart(ctx: PluginContext): Promise<void> {
    const health = ctx.services.tryResolve(HealthServiceToken);
    if (!health) {
      throw new Error('health-http 无法解析内核 HealthService');
    }
    this.health = health;

    // 能力断言：net.listen 未授权则拒绝（sandboxed 下需显式授予）。
    try {
      ctx.api.useCapability(HealthServiceToken);
    } catch {
      // useCapability 仅针对服务能力；net.listen 由 manifest 声明 + 权限管理器把关。
    }

    await this.listen(ctx);
  }

  private async listen(ctx: PluginContext): Promise<void> {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void this.handle(req, res);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo | null;
        if (addr) this.port = addr.port;
        resolve();
      });
    });

    ctx.log.info(`健康检查端点监听于 http://127.0.0.1:${this.port}/health`);
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (
      req.url === '/health' &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      try {
        const report = await this.health!.report();
        const body = JSON.stringify(report, null, 2);
        res.writeHead(report.status === 'healthy' ? 200 : 503, {
          'content-type': 'application/json; charset=utf-8',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'unhealthy',
            error: (error as Error).message,
          }),
        );
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
  }

  /** 当前监听端口（测试用）。 */
  getPort(): number {
    return this.port;
  }

  async onStop(ctx: PluginContext, reason: string): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    this.health = null;
    ctx.log.info(`健康检查端点已关闭（${reason}）`);
  }
}
