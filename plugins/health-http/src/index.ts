/**
 * health-http plugin -- operational endpoints are plugins.
 *
 * - Provides `health.expose` + `net.listen`: exposes the kernel HealthService
 *   as HTTP /health.
 * - Hard dependency on logger-console: demonstrates that hard dependencies
 *   participate in topological ordering (logger-console starts first).
 */

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { definePlugin, defineToken, KernelTokens } from 'rem2-kernel'
import type { HealthReport, PluginContext } from 'rem2-kernel'

/** Minimal structural type for the kernel HealthService. */
export interface HealthServiceLike {
  report(): Promise<HealthReport>
}

/** Token with the same id as the kernel KernelTokens.Health. */
export const HealthServiceToken = defineToken<HealthServiceLike>({
  id: KernelTokens.Health.id,
  describe: 'Kernel health service',
})

export default definePlugin(
  {
    id: 'com.rem2.health-http',
    name: 'Health HTTP Endpoint',
    version: '1.0.0',
  },
  (ctx: PluginContext) => {
    let server: Server | null = null
    let health: HealthServiceLike | null = null
    let port = 0

    async function handle(
      req: IncomingMessage,
      res: ServerResponse,
    ): Promise<void> {
      if (
        req.url === '/health' &&
        (req.method === 'GET' || req.method === 'HEAD')
      ) {
        try {
          const report = await health!.report()
          const body = JSON.stringify(report, null, 2)
          res.writeHead(report.status === 'healthy' ? 200 : 503, {
            'content-type': 'application/json; charset=utf-8',
          })
          res.end(req.method === 'HEAD' ? undefined : body)
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              status: 'unhealthy',
              error: (error as Error).message,
            }),
          )
        }
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not Found')
    }

    return {
      async onConfigure(): Promise<void> {
        // The port is configurable; 0 means random.
        port = ctx.config.get<number>('health.http.port', 0)
      },

      async onStart(): Promise<void> {
        const svc = ctx.services.tryResolve(HealthServiceToken)
        if (!svc) {
          throw new Error('health-http cannot resolve the kernel HealthService')
        }
        health = svc

        server = createServer((req: IncomingMessage, res: ServerResponse) => {
          void handle(req, res)
        })
        await new Promise<void>((resolve, reject) => {
          server!.once('error', reject)
          server!.listen(port, '127.0.0.1', () => {
            const addr = server!.address() as AddressInfo | null
            if (addr) port = addr.port
            resolve()
          })
        })

        ctx.log.info(
          `Health endpoint listening on http://127.0.0.1:${port}/health`,
        )
      },

      async onStop(hookCtx: PluginContext, reason: string): Promise<void> {
        const s = server
        server = null
        health = null
        if (s) {
          await new Promise<void>(resolve => {
            s.close(() => resolve())
          })
        }
        hookCtx.log.info(`Health endpoint closed (${reason})`)
      },

      /** Current listening port (for tests). */
      getPort(): number {
        return port
      },
    }
  },
)
