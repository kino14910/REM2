/**
 * 主进程构建配置。
 *
 * 共享项（alias / conditions / ssr.noExternal / sourcemap）来自 `vite.shared.mts`。
 * ★ `ssr.noExternal: ['rem2-kernel']` 是最关键的一项：默认 externalize 会让产物留下
 * `require('rem2-kernel')`，打包态解析到 `.ts` 入口直接 `ERR_UNKNOWN_FILE_EXTENSION`。
 * 这个错误只在打包后出现，开发态看不出来。
 */

import { defineConfig } from 'vite';
import { NODE_SHARED } from './vite.shared.mjs';

export default defineConfig({
  ...NODE_SHARED,
  build: {
    ...NODE_SHARED.build,
    // ★ 声明为 SSR(Node) 构建：否则 vite 按「浏览器客户端」处理，
    // 会把 node:fs / node:worker_threads 等全部 externalize 掉，
    // 产物在 Electron 主进程里直接不可用。
    // （forge 的 VitePlugin 在真实打包时也会注入它，这里显式写是为了让配置自洽：
    //   单独跑 `vite build --config vite.main.config.mts` 也能出正确产物。）
    ssr: 'src/main.ts',
    // ★ 必须显式指定：vite 默认 outDir 是 dist，而 dist/ 是**内核产物**目录
    // （tsconfig.build.json 的 outDir）。共用会让主进程构建清空内核产物。
    // .vite/build 也是 forge VitePlugin 在打包态的产物位置。
    outDir: '.vite/build',
    rollupOptions: {
      // electron 由运行时提供，不能打进产物。
      external: ['electron'],
      // 保留转发壳形态，forge.config.mts 的 entry 不必改。
      input: 'src/main.ts',
    },
  },
});
