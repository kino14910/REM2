/**
 * Electron Forge preload entry (a forwarding shell).
 *
 * It is kept so that the `forge.config.mts` entry stays fixed; the implementation
 * lives in `src/host/electron/preload.ts`.
 */

import './host/electron/preload.js'
