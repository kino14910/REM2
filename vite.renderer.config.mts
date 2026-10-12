/**
 * renderer 构建配置 —— **唯一**挂 svelte 插件的 config（边界 B1）。
 *
 * CSP 兼容：Svelte 5 的 `$state` / `$derived` 编译为普通 JS，**不需要 `eval`**，
 * 因此 `index.html` 的 `script-src 'self'` 无需加 `unsafe-eval`。
 */

import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { KERNEL_RESOLVE, KERNEL_BUILD } from './vite.shared.mjs';

export default defineConfig({
  // renderer 的入口是根目录的 index.html（它引用 /src/frontend/entry-client.ts）。
  root: '.',
  plugins: [svelte()],
  resolve: {
    // 前端实际不 import 内核（B3 由契约测试 R6 把关），但保持一致以防误用。
    ...KERNEL_RESOLVE,
    // ★ 必须与 Node 侧的 NODE_CONDITIONS 分开声明。
    // `resolve.conditions` 是整体替换默认集（Vite 8 `mergeWithDefaultsRecursively`），
    // 所以这里必须给出 browser 语义，否则 svelte 的 exports 会落到 server 入口，
    // `mount()` 抛 lifecycle_function_unavailable → 白屏（详见 vite.shared.mts）。
    conditions: ['browser', 'import', 'module'],
  },
  build: {
    ...KERNEL_BUILD,
    // 对齐 Electron 44 的 Chromium。
    target: 'chrome120',
    // ★ 必须显式指定：vite 的默认 outDir 是 `dist`，而 `dist/` 是**内核产物**的目录
    // （tsconfig.build.json 的 outDir）。共用会让 renderer 构建清空内核产物。
    // 这个目录也正是 forge VitePlugin 在打包态的产物位置。
    outDir: '.vite/renderer/main_window',
    rollupOptions: {
      input: 'index.html',
    },
  },
  server: {
    fs: {
      // svelte 插件需要读项目根下的 .svelte / .ts 源文件。
      allow: ['.'],
    },
  },
});
