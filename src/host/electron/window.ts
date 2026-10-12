/**
 * `createWindow()`：窗口创建（含 CSP 与 sandbox 设置）。
 *
 * 从 `main.ts` 抽出，理由是它承载了「renderer 的安全边界」这一独立关注点：
 * - `contextIsolation: true` + `sandbox: true` → renderer 在 contextIsolation 下无 Node 能力。
 * - `preload: path.join(__dirname, 'preload.cjs')` —— **文件名是隐式契约**，
 *   `vite.preload.config.mts` 必须保证产物名就是 `preload.cjs`。
 */

import { BrowserWindow } from 'electron';
import path from 'node:path';

/**
 * Electron Forge Vite 插件注入的**编译期常量**（不是运行期环境变量）。
 *
 * 重要：Forge 通过 Vite 的 `define` 替换的是**裸标识符**，因此必须直接写
 * `MAIN_WINDOW_VITE_DEV_SERVER_URL`，**不能**写 `process.env.MAIN_WINDOW_VITE_DEV_SERVER_URL`
 * —— 后者不会被替换，运行期恒为 undefined，导致窗口永远走 `file://` 分支。
 */
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
/** 渲染进程名（打包态用于定位 `.vite/renderer/<name>/index.html`）。 */
declare const MAIN_WINDOW_VITE_NAME: string;

export interface CreateWindowOptions {
  width?: number;
  height?: number;
}

/** 创建主窗口。 */
export function createWindow(opts: CreateWindowOptions = {}): BrowserWindow {
  const window = new BrowserWindow({
    width: opts.width ?? 960,
    height: opts.height ?? 720,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      // renderer 现在要跑 Svelte（需要 window/DOM），sandbox 仍可用：
      // sandbox 下的 preload 依旧能用 contextBridge 与 ipcRenderer，
      // 但 renderer 拿不到 Node 能力 —— 这正是我们要的。
      sandbox: true,
    },
  });

  // 开发态：加载 Vite dev server（HMR）。打包态：加载渲染产物。
  // 打包态路径是 `.vite/renderer/<name>/index.html`，**不是** `.vite/build/`。
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  return window;
}
