/**
 * Electron Forge 主进程入口（可选外壳）。
 *
 * 真正的 Electron 逻辑在 `src/electron-shell/main.ts`；此处仅作为 Forge 的 main 入口转发，
 * 以保持"内核零 Electron 依赖"的边界（Electron 代码全部隔离在 electron-shell/）。
 */

import './electron-shell/main.js';
