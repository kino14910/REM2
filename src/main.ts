/**
 * Electron Forge main-process entry (a forwarding shell).
 *
 * It is kept because `forge.config.mts` needs a fixed `build[].entry` path;
 * the real Electron logic lives in `src/host/electron/main.ts`.
 */

import './host/electron/main.js'
