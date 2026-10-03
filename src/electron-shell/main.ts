/**
 * Electron 主进程外壳（**可选**，docs/02 §A.1 / 附录 B #1）。
 *
 * 本文件是 Electron 的宿主入口，**不参与内核逻辑**；内核可完全独立于本文件运行。
 * 它演示：把 Kernel 当作库启动，并通过 IpcBridge 把渲染进程命令转发到内核事件总线。
 *
 * 注意：为保持"内核零 Electron 依赖"，此处的 Electron 相关 import 仅存在于本目录。
 */

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import process from 'node:process';
import { Kernel } from '../kernel/kernel.js';
import { IpcBridge } from '../runtime/ipc/ipc-bridge.js';
import { IpcTopics } from '../runtime/ipc/ipc-topics.js';
import { KernelTokens } from '../kernel/contracts/kernel-tokens.js';
import { builtinPluginsRoot } from '../runtime/bootstrap/paths.js';
import { ThemeRegistryImpl } from './theme-registry.js';
import { ThemeRegistryToken } from '../../plugins/theme-dark/src/index.js';
import type { EventBus } from '../kernel/contracts/event-bus.js';
import type { CapabilityGuard } from '../kernel/security/capability-guard.js';

let kernel: Kernel | null = null;
let bridge: IpcBridge | null = null;

/**
 * 无 GPU / 虚拟化环境（虚拟机、CI、远程桌面、受限沙箱）下，Chromium 的 GPU 进程可能反复崩溃
 * （`GPU process isn't usable. Goodbye.`），导致外壳起不来。
 *
 * 通过 `REM2_DISABLE_GPU=1` 显式关闭硬件加速并禁用 GPU 相关子系统；
 * **默认不开启**，以免影响正常机器上的渲染性能。
 * 必须在 `app.whenReady()` 之前调用。
 */
if (process.env.REM2_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('in-process-gpu');
}

/**
 * 注册 TS 运行时加载器（**外壳职责**，内核零感知）。
 *
 * 为什么外壳必须做这件事：插件入口是磁盘上的 `.ts`（`plugin.json` 的 `entry`），
 * 内核用动态 `import()` 加载它。而 Electron 主进程只能走 Node 原生 TS 支持
 * （strip-only），它既**不支持 TS 参数属性**（`constructor(private x: T)`），
 * 也**不会把 `.js` 说明符重映射到 `.ts`**（内核源码全部用 `.js` 后缀导入）。
 *
 * 后果：所有 `.ts` 插件加载失败 → `Failed`，于是命令主题没有任何响应者，
 * 渲染进程执行 `hello` 只会得到「事件主题无响应者：command:execute」。
 *
 * 因此在启动内核**之前**注册 tsx 的 ESM loader hook。tsx 是外壳的**开发期**依赖
 * （`devDependencies`）——内核与 `dependencies` 依旧零第三方依赖（契约测试强制）；
 * 打包产物需要自带 TS 管线时再把它提为运行时依赖。
 */
async function registerTsLoader(): Promise<void> {
  // 说明符刻意不做成字面量：打包器会把「字面量动态 import」重写成 CJS `require()`，
  // 而 tsx 的 ESM API 只能通过真正的 `import()` 加载（require 分支自身会崩）。
  const specifier = ['tsx', 'esm', 'api'].join('/');
  const mod = (await import(/* @vite-ignore */ specifier)) as {
    register(): void;
  };
  mod.register();
}

/** 启动内核（外壳仅是载体）。 */
async function startKernel(): Promise<void> {
  // 必须在 kernel.start()（会动态 import 各插件入口）之前完成。
  try {
    await registerTsLoader();
  } catch (error) {
    // 显式暴露：静默失败会退化成「命令无响应者」，几乎无法排查。
    throw new Error(
      'TS 加载器注册失败（tsx 不可用？），.ts 插件将无法加载：' +
        `${(error as Error).message}`,
    );
  }

  kernel = new Kernel({
    id: 'rem2-electron',
    roots: [],
    builtinRoot: builtinPluginsRoot(),
    startTimeoutMs: 5000,
    stopTimeoutMs: 5000,
    legacyFallback: false,
    logLevel: 'info',
    initialConfig: { app: { greeting: 'Hello from Electron shell' } },
  });

  // 外壳作为宿主提供 ThemeRegistry 能力：在内核启动**之前**注册，
  // 使 theme-dark 等 UI 插件在 onStart 时能解析到它（否则只能降级）。
  // 该服务要求 `ui.theme` 能力（theme-dark 已声明并获授）。
  kernel.root.registerInstance(ThemeRegistryToken, new ThemeRegistryImpl());
  const guard = kernel.root.resolve(
    KernelTokens.CapabilityGuard,
  ) as CapabilityGuard;
  guard.declareServiceCapability(ThemeRegistryToken.id, 'ui.theme');

  await kernel.start();

  const bus = kernel.root.resolve<EventBus>(KernelTokens.EventBus);
  bridge = new IpcBridge(bus);
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

/**
 * Electron Forge Vite 插件注入的**编译期常量**（不是运行期环境变量）。
 *
 * 重要：Forge 通过 Vite 的 `define` 替换的是**裸标识符**，因此必须直接写
 * `MAIN_WINDOW_VITE_DEV_SERVER_URL`，**不能**写 `process.env.MAIN_WINDOW_VITE_DEV_SERVER_URL`
 * —— 后者不会被替换，运行期恒为 undefined，导致窗口永远走 `file://` 分支。
 *
 * 取值来源：`@electron-forge/plugin-vite` 的 `getBuildDefine()`
 * （`command === 'serve'` 时为 dev server URL，否则为 undefined）。
 * 常量名 = 渲染进程名大写化，本项目在 `forge.config.mts` 中渲染进程名为 `main_window`。
 */
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
/** 渲染进程名（打包态用于定位 `.vite/renderer/<name>/index.html`）。 */
declare const MAIN_WINDOW_VITE_NAME: string;

function createWindow(): void {
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
    },
  });

  // 开发态：加载 Vite dev server（HMR）。打包态：加载渲染产物。
  // 注意打包态路径是 `.vite/renderer/<name>/index.html`，**不是** `.vite/build/`。
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
}

app.whenReady().then(async () => {
  try {
    await startKernel();
  } catch (error) {
    // 外壳只是载体，但"内核起不来"必须**显式暴露**：
    // 否则只会变成一个静默的 unhandled rejection —— 用户看到的是"窗口没出现"，无从排查。
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

// 兜底：任何未捕获的异步错误都打出来，避免"静默失败"。
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

export { IpcTopics };
