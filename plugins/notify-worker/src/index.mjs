/**
 * notify-worker 插件 —— 通知功能是插件，且运行在独立 Worker 线程（isolation: 'worker'）。
 *
 * 它演示：
 * 1. Worker 隔离：本模块代码运行在独立的 Node Worker 线程，崩溃/死循环不影响内核。
 * 2. 上下文代理：ctx.log / ctx.events / ctx.metrics / ctx.config 通过 RPC 跨线程访问内核。
 * 3. 事件驱动协作：订阅 command:result（由 hello-command 发出）并转发为通知事件。
 *
 * 形态：唯一形态 = default 导出工厂函数。Worker 内没有 TS 编译管线，
 * 所以本文件保持纯 ESM（.mjs）；构建后由 esbuild 产出 dist/index.js。
 *
 * 注意：Worker 插件没有 ctx.services / ctx.api（跨线程无法代理）；
 * ctx.extensions 仅允许贡献 log.sink / metrics.sink / trace.exporter 三类 sink。
 */

/** 通知事件主题（其他插件/外壳可订阅）。 */
const NotifyTopics = {
  Notified: 'notify:notified',
};

/** 唯一形态：工厂函数，签名与内核 `PluginFactory` 一致。 */
export default function notifyWorkerPlugin(ctx) {
  const unsubs = [];
  let notificationsSent = 0;

  return {
    async onStart() {
      unsubs.push(
        ctx.events.on('command:result', async (payload) => {
          notificationsSent += 1;
          const message = (payload && payload.output) || '(empty)';
          // 跨线程发事件：经 Worker 宿主 RPC 到内核总线。
          await ctx.events.emit(NotifyTopics.Notified, {
            message,
            at: Date.now(),
            seq: notificationsSent,
          });
          ctx.metrics
            .counter('notify.sent', { pluginId: 'com.rem2.notify-worker' })
            .add(1);
          ctx.log.info(`已通知：${message}`);
        }),
      );
      ctx.log.info('notify-worker 已在独立 Worker 线程启动');
    },

    async onStop(_c, reason) {
      for (const u of unsubs) u();
      unsubs.length = 0;
      ctx.log.info(`notify-worker 已停止（${reason}）`);
    },

    onHealthCheck() {
      return unsubs.length > 0 ? 'healthy' : 'degraded';
    },
  };
}
