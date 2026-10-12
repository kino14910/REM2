/**
 * Electron 主进程：内核的**宿主**，不是权威（docs/12 B4）。
 *
 * 相对旧版的改动（docs/13 §1.4 #5）：
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
import { IpcBridge, type EventForwardMap } from '../ipc/bridge.js';
import { ALLOWED_EVENTS } from '../ipc/channels.js';
import { Topics } from '../../kernel/topics.js';
import { builtinPluginsRoot } from '../cli/paths.js';
import { createWindow } from './window.js';
import type { EventBus } from '../../kernel/contracts/event-bus.js';
import type { HealthReport } from '../../kernel/contracts/health.js';
import type { PluginStateT } from '../../kernel/contracts/plugins.js';
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
 * 内核 topic → 对外事件名的降维映射。
 *
 * 只列白名单里的 5 个事件；每个 mapper 只投影必要字段（docs/12 §5.3 的 DTO 化意义：
 * 内核 `PluginInfo` / `HealthReport` 含 container、permissions、绝对路径，绝不能外泄）。
 */
const EVENT_FORWARD_MAP: EventForwardMap = [
  {
    topic: Topics.UiThemeChanged,
    event: 'ui.theme.changed',
    toDto: (p) => p as ThemeDefinition,
  },
  {
    topic: Topics.PluginStateChanged,
    event: 'plugin.state-changed',
    toDto: (p) => {
      const v = p as { pluginId: string; state: PluginStateT };
      return { pluginId: v.pluginId, state: v.state };
    },
  },
  {
    topic: Topics.PanelDataChanged,
    event: 'panel.data-changed',
    toDto: (p) => p,
  },
  {
    topic: Topics.CommandResult,
    event: 'command.result',
    toDto: (p) => p,
  },
  {
    topic: Topics.KernelReady,
    event: 'kernel.ready',
    toDto: (p) => p,
  },
];

/** 内核 RPC 响应者：把 8 个白名单方法映射到扩展点 / 内核服务。 */
function respondToWhitelistedMethods(kernelRef: Kernel): void {
  const events = kernelRef.root.resolve<EventBus>(KernelTokens.EventBus);

  // 1) ui.panel.list
  events.respond('ui.panel.list', () =>
    kernelRef.extensions.listAll<PanelContribution>('ui.panel'),
  );
  // 2) ui.panel.data：按面板声明的 command 走事件总线（数据形状由插件自定）
  events.respond<{ panelId: string }, unknown>('ui.panel.data', async (args) => {
    const panels = kernelRef.extensions.listAll<PanelContribution>('ui.panel');
    const panel = panels.find((p) => p.panelId === args?.panelId);
    if (!panel) throw new Error(`面板不存在：${args?.panelId ?? '(none)'}`);
    return await events.request(panel.command, { panelId: panel.panelId });
  });
  // 3) ui.route.list
  events.respond('ui.route.list', () =>
    kernelRef.extensions.listAll<RouteContribution>('ui.route'),
  );
  // 4) ui.theme.list
  events.respond('ui.theme.list', () => themeRegistry.list());
  // 5) ui.theme.set
  events.respond<{ themeId: string }, { ok: boolean }>('ui.theme.set', (args) => {
    const ok = themeRegistry.activate(String(args?.themeId ?? ''));
    if (ok) {
      void events.emit(
        Topics.UiThemeChanged,
        themeRegistry.get(themeRegistry.active() ?? '') ?? null,
      );
    }
    return { ok };
  });
  // 6) ui.event：按面板声明路由到对应命令
  events.respond<{ panelId: string; kind: string; payload?: unknown }, { ok: boolean }>(
    'ui.event',
    async (args) => {
      const panels = kernelRef.extensions.listAll<PanelContribution>('ui.panel');
      const panel = panels.find((p) => p.panelId === args?.panelId);
      if (!panel) return { ok: false };
      await events.request(panel.command, {
        kind: args?.kind,
        payload: args?.payload,
      });
      return { ok: true };
    },
  );
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
      const listener = (_e: unknown, payload: unknown): void => handler(payload);
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
