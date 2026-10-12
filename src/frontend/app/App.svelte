<!--
  根组件：首屏编排。

  四类数据并行拉取、各自降级为空（不阻塞渲染）；事件订阅的退订函数
  交给 `onMount` 的返回值，由运行时在销毁时统一清理（对应内核的 `Unsubscribe` 语义）。
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Shell from './Shell.svelte';
  import CommandPrompt from './components/CommandPrompt.svelte';
  import ThemeToggle from './components/ThemeToggle.svelte';
  import { ipc } from '../lib/ipc-client';
  import { events } from '../lib/channels';
  import { panels } from '../lib/stores/panels.svelte';
  import { routes } from '../lib/stores/routes.svelte';
  import { theme } from '../lib/stores/theme.svelte';
  import { health } from '../lib/stores/health.svelte';
  import type { ThemeDto } from '../lib/bridge-types';

  onMount(() => {
    void panels.load();
    void routes.load();
    void theme.load();
    void health.load();

    // 主题切换事件 → 重算 CSS 变量。
    const offTheme = ipc.subscribe(events.themeChanged, (payload) => {
      theme.setActive(payload as ThemeDto);
    });
    return () => {
      offTheme();
    };
  });
</script>

<div class="app">
  <header class="topbar">
    <CommandPrompt />
    <ThemeToggle />
  </header>
  <Shell />
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .topbar {
    display: flex;
    gap: var(--rem2-space-sm);
    align-items: center;
    padding: var(--rem2-space-sm) var(--rem2-space-md);
    border-bottom: 1px solid var(--rem2-color-border);
  }
</style>
