/**
 * Electron Forge preload 入口（转发壳）。
 *
 * 保留它是为了让 `forge.config.mts` 的 entry 固定；实现见 `src/host/electron/preload.ts`。
 */

import './host/electron/preload.js';
