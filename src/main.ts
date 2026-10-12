/**
 * Electron Forge 主进程入口（转发壳）。
 *
 * 保留它是因为 `forge.config.mts` 的 `build[].entry` 需要一个固定路径；
 * 真正的 Electron 逻辑在 `src/host/electron/main.ts`。
 */

import './host/electron/main.js';
