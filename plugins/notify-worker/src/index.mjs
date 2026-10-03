/**
 * notify-worker 插件 —— 通知功能是插件，且运行在独立 Worker 线程（isolation: 'worker'）。
 *
 * 它演示：
 * 1. Worker 隔离：本模块代码运行在独立的 Node Worker 线程，崩溃/死循环不影响内核。
 * 2. 上下文代理：ctx.log / ctx.events / ctx.metrics / ctx.config 通过 RPC 跨线程访问内核。
 * 3. 事件驱动协作：订阅 `command:result`（由 hello-command 发出）并转发为通知事件。
 *
 * 注意：
 * - Worker 插件没有 `ctx.services` / `ctx.api`（跨线程无法代理），
 *   与其他插件的协作只能走事件总线。
 * - 本文件用纯 ESM（.mjs）编写：Worker 线程内没有 TS 编译管线，
 *   .mjs 在 tsx / vitest / Electron 打包三种形态下都能被原生 import。
 */

/** 通知事件主题（其他插件/外壳可订阅）。 */
const NotifyTopics = {
  Notified: 'notify:notified',
};

class NotifyWorkerPlugin {
  constructor() {
    /** 插件清单（Worker 侧仅作展示；权威清单是 plugin.json）。 */
    this.manifest = {
      id: 'com.rem2.notify-worker',
      name: 'Notify Worker',
      version: '1.0.0',
      entry: 'src/index.mjs',
      isolation: 'worker',
      capabilities: ['log.sink'],
      compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
      author: 'rem2-team',
      description: '在独立 Worker 线程中运行：订阅命令结果并发出通知',
      tags: ['notification', 'demo', 'worker'],
    };
    /** @type {Array<() => void>} */
    this.unsubs = [];
    this.notificationsSent = 0;
  }

  /** @param {any} ctx 由 Worker 引导注入的上下文代理 */
  async onStart(ctx) {
    this.unsubs.push(
      ctx.events.on('command:result', async (payload) => {
        this.notificationsSent += 1;
        const message = (payload && payload.output) || '(empty)';
        // 跨线程发事件：经 Worker 宿主 RPC 到内核总线。
        await ctx.events.emit(NotifyTopics.Notified, {
          message,
          at: Date.now(),
          seq: this.notificationsSent,
        });
        ctx.metrics
          .counter('notify.sent', { pluginId: 'com.rem2.notify-worker' })
          .add(1);
        ctx.log.info(`已通知：${message}`);
      }),
    );
    ctx.log.info('notify-worker 已在独立 Worker 线程启动');
  }

  async onStop(ctx, reason) {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    ctx.log.info(`notify-worker 已停止（${reason}）`);
  }

  onHealthCheck() {
    return this.unsubs.length > 0 ? 'healthy' : 'degraded';
  }
}

export default NotifyWorkerPlugin;
