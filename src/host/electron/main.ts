/**
 * Electron 主进程：内核的**宿主**，不是权威（docs/04 B4）。
 *
 * 相对旧版的改动（docs/06 §1.4 #5）：
 * ① 删除 `registerTsLoader()` 与动态 `import('tsx/esm/api')` —— 插件入口改为预编译产物，
 *    且 forge Fuses 已封死 `NODE_OPTIONS=--import=tsx` 通道，保留它只会是死代码；
 * ② 删除对 `plugins/theme-dark/src/index.js` 的 import（诊断报告的 X1 越界）；
 * ③ ThemeRegistry 改为经 `ui.theme` 扩展点暴露，不再 `root.registerInstance` 特判插件；
 * ④ `sandbox: true`（已移入 `window.ts`）；
 * ⑤ `Kernel` 用 `createDeps()` 装配。
 */

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import process from 'node:process';
import { Kernel } from '../../kernel/kernel.js';
import { createDeps } from '../../kernel/composition.js';
import { KernelTokens } from '../../kernel/contracts/kernel-tokens.js';
import { IpcBridge } from '../ipc/bridge.js';
import { ALLOWED_EVENTS } from '../ipc/channels.js';
import { EVENT_FORWARD_MAP } from '../ipc/forward-map.js';
import { Topics } from '../../kernel/topics.js';
import { builtinPluginsRoot } from '../cli/paths.js';
import { createWindow } from './window.js';
import type { EventBus } from '../../kernel/contracts/event-bus.js';
import type { HealthReport } from '../../kernel/contracts/health.js';
import type {
  PanelContribution,
  RouteContribution,
  ThemeDefinition,
} from '../../kernel/contracts/ui.js';
import { ThemeRegistryImpl } from './theme-registry.js';

let kernel: Kernel | null = null;
let bridge: IpcBridge | null = null;

/**
 * 无 GPU / 虚拟化环境（虚拟机、CI、远程桌面、受限沙箱）下，Chromium 的 GPU 进程可能反复崩溃。
 * 通过 `REM2_DISABLE_GPU=1` 显式关闭；**默认不开启**。必须在 `app.whenReady()` 之前调用。
 */
if (process.env.REM2_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('in-process-gpu');
}

/** 宿主侧主题注册表（`ui.theme` 单例槽背后的服务，不 import 任何插件）。 */
const themeRegistry = new ThemeRegistryImpl();

/**
 * 内核 topic → 对外事件名的降维映射（见 `host/ipc/forward-map.ts`）。
 *
 * 单独成文件的理由写在那个文件里：它是契约的第三份副本，
 * 必须能被测试直接 import，否则三方镜像各抄各的、改错不红。
 */

/**
 * 把 `ui.theme` 扩展点槽的贡献同步进主题注册表。
 *
 * ★ 为什么需要这座桥（曾真实断裂）：
 * `theme-dark` 把主题贡献进 `ui.theme` 单例槽，但本文件的 responder 读的是
 * `themeRegistry`（一块独立内存）。两侧之间**没有任何代码连通**，于是主题数据
 * 进了扩展点就断了 —— `ui.theme.list` 恒返回 []、`ui.theme.set` 恒失败，
 * 前端永远拿不到主题。这是「生产者注册了、消费者没接」的又一例。
 *
 * 用 **pull（每次读时同步）** 而非订阅生命周期事件：扩展点槽是单一真相源，
 * 主题注册表退化为缓存。插件卸载时内核按 pluginId 强制回收贡献（P6），
 * 下一次 pull 自然就同步为空，不需要额外监听 unload。
 */
function syncThemeFromExtension(kernelRef: Kernel): void {
  const contributed =
    kernelRef.extensions.resolveSingle<ThemeDefinition>('ui.theme');
  for (const t of themeRegistry.list()) {
    if (!contributed || t.id !== contributed.id) themeRegistry.unregister(t.id);
  }
  if (contributed && !themeRegistry.get(contributed.id)) {
    themeRegistry.register(contributed);
    // 首个可用主题即激活，让前端首屏就有主题可应用。
    themeRegistry.activate(contributed.id);
  }
}

/** 内核 RPC 响应者：把 8 个白名单方法映射到扩展点 / 内核服务。 */
function respondToWhitelistedMethods(kernelRef: Kernel): void {
  const events = kernelRef.root.resolve<EventBus>(KernelTokens.EventBus);

  // 1) ui.panel.list
  events.respond('ui.panel.list', () =>
    kernelRef.extensions.listAll<PanelContribution>('ui.panel'),
  );
  // 2) ui.panel.data：按面板声明的 command 走事件总线（数据形状由插件自定）
  events.respond<{ panelId: string }, unknown>(
    'ui.panel.data',
    async (args) => {
      const panels =
        kernelRef.extensions.listAll<PanelContribution>('ui.panel');
      const panel = panels.find((p) => p.panelId === args?.panelId);
      if (!panel) throw new Error(`面板不存在：${args?.panelId ?? '(none)'}`);
      return await events.request(panel.command, { panelId: panel.panelId });
    },
  );
  // 3) ui.route.list
  events.respond('ui.route.list', () =>
    kernelRef.extensions.listAll<RouteContribution>('ui.route'),
  );
  // 4) ui.theme.list —— 先从扩展点槽拉取，再返回
  events.respond('ui.theme.list', () => {
    syncThemeFromExtension(kernelRef);
    return themeRegistry.list();
  });
  // 5) ui.theme.set
  events.respond<{ themeId: string }, { ok: boolean }>(
    'ui.theme.set',
    (args) => {
      syncThemeFromExtension(kernelRef);
      const ok = themeRegistry.activate(String(args?.themeId ?? ''));
      if (ok) {
        void events.emit(
          Topics.UiThemeChanged,
          themeRegistry.get(themeRegistry.active() ?? '') ?? null,
        );
      }
      return { ok };
    },
  );
  // 6) ui.event：按面板声明路由到对应命令
  events.respond<
    { panelId: string; kind: string; payload?: unknown },
    { ok: boolean }
  >('ui.event', async (args) => {
    const panels = kernelRef.extensions.listAll<PanelContribution>('ui.panel');
    const panel = panels.find((p) => p.panelId === args?.panelId);
    if (!panel) return { ok: false };
    await events.request(panel.command, {
      kind: args?.kind,
      payload: args?.payload,
    });
    return { ok: true };
  });
  // 7) command.execute：**不注册转发器**。
  //    曾有一条 `respond('command.execute', () => request(Topics.CommandExecute))`，
  //    而 `Topics.CommandExecute` 正是 `'command.execute'` 自身 → request 命中同一个
  //    responder → 无限递归 → RangeError: Maximum call stack size exceeded。
  //    现在由命令插件直接 respond 该 topic；无命令插件时 request 抛 NoResponderError，
  //    前端会明确报错 —— 这比静默或递归都好。
  // 8) health.report
  events.respond('health.report', async () => {
    const report: HealthReport = await kernelRef.health();
    return {
      status: report.status,
      plugins: report.plugins.map((p) => ({
        id: p.id,
        state: p.state,
        status: p.status,
        ...(p.message ? { message: p.message } : {}),
      })),
    };
  });
}

/** 启动内核。 */
async function startKernel(): Promise<void> {
  kernel = new Kernel(
    createDeps({
      id: 'rem2-electron',
      roots: [],
      builtinRoot: builtinPluginsRoot(),
      startTimeoutMs: 5000,
      stopTimeoutMs: 5000,
      legacyFallback: false,
      logLevel: 'info',
      initialConfig: { app: { greeting: 'Hello from Electron shell' } },
    }),
  );

  // 宿主提供的 UI 侧服务：只经 KernelTokens 暴露，不对任何具体插件做特判。
  kernel.root.registerInstance(KernelTokens.UiThemeRegistry, themeRegistry);

  respondToWhitelistedMethods(kernel);
  await kernel.start();

  const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus);
  bridge = new IpcBridge(bus, {
    allowedEvents: new Set(ALLOWED_EVENTS),
    forwardMap: EVENT_FORWARD_MAP,
  });
  bridge.bind({
    send: (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(channel, payload);
      }
    },
    on: (channel, handler) => {
      const listener = (_e: unknown, payload: unknown): void =>
        handler(payload);
      ipcMain.on(channel, listener);
      return () => ipcMain.removeListener(channel, listener);
    },
  });
}

app.whenReady().then(async () => {
  try {
    await startKernel();
  } catch (error) {
    // 外壳只是载体，但「内核起不来」必须**显式暴露**：
    // 否则只会变成静默的 unhandled rejection —— 用户看到的是「窗口没出现」，无从排查。
    const message = error instanceof Error ? error.message : String(error);
    console.error('[rem2] 内核启动失败：', error);
    dialog.showErrorBox('rem2 内核启动失败', message);
    app.quit();
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 兜底：任何未捕获的异步错误都打出来，避免「静默失败」。
process.on('unhandledRejection', (reason) => {
  console.error('[rem2] 未处理的 Promise 拒绝：', reason);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  bridge?.unbind();
  if (kernel) {
    await kernel.shutdown();
    kernel = null;
  }
});
