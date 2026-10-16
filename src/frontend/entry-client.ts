/**
 * 渲染进程入口：只做挂载，不含任何逻辑（docs/04 §2）。
 *
 * 注意：renderer **不得** import 内核 —— 与内核的唯一通道是 `window.rem2`
 * （契约测试 R6 把关）。因此本文件只引 Svelte 与本地组件。
 */

import './app/global.css';
import { mount } from 'svelte';
import App from './app/App.svelte';

const target = document.getElementById('app');
if (!target) {
  throw new Error('挂载点 #app 不存在（检查 index.html）');
}

export default mount(App, { target });
