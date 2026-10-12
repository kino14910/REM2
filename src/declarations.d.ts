/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
declare module '*.css';

/**
 * Svelte 组件的模块声明。
 *
 * `tsc` 不解析 `.svelte`（那是 svelte 编译器的事），因此这里给出最小形状：
 * 默认导出一个可被 `mount()` 接受的组件。真实类型由 svelte-check / vite 提供。
 */
declare module '*.svelte' {
  import type { Component } from 'svelte';
  const component: Component<Record<string, never>>;
  export default component;
}
