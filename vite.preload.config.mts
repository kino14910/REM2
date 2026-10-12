/**
 * preload 构建配置。
 *
 * ⚠ 产物名**必须是 `preload.cjs`**：`host/electron/window.ts` 里
 * `path.join(__dirname, 'preload.cjs')` 是硬编码的。改名会导致「preload 脚本加载失败」，
 * 而且**报错信息不会提示是文件名问题**。这是 docs/12 §10 R4 点名的隐式契约。
 */

import { defineConfig } from 'vite';
import { NODE_SHARED } from './vite.shared.mjs';

export default defineConfig({
  ...NODE_SHARED,
  build: {
    ...NODE_SHARED.build,
    // 同 vite.main.config.mts：声明 Node 语义，否则 node: 模块会被当浏览器依赖 externalize。
    ssr: 'src/preload.ts',
    // ★ 必须显式指定：vite 默认 outDir 是 dist，而 dist/ 是**内核产物**目录
    // （tsconfig.build.json 的 outDir）。共用会让主进程构建清空内核产物。
    // .vite/build 也是 forge VitePlugin 在打包态的产物位置。
    outDir: '.vite/build',
    rollupOptions: {
      external: ['electron'],
      input: 'src/preload.ts',
      output: {
        // preload 必须 CJS：contextBridge 依赖 CommonJS 语义。
        format: 'cjs',
        entryFileNames: '[name].cjs',
      },
    },
  },
});
