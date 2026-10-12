<!--
  ui.panel 插槽：渲染 `ui.panel` 扩展点贡献的面板。

  ★ 本文件**不出现任何插件 id** —— 代码写一次，插件决定内容。
  chrome（边框/标题栏/空态）由宿主负责，插件只提供描述数据。
-->
<script lang="ts">
  import PanelShell from './components/PanelShell.svelte';
  import { panels } from '../lib/stores/panels.svelte';
</script>

<section class="panel-host">
  {#if panels.active}
    <PanelShell panel={panels.active} />
  {:else}
    <p class="empty">暂无面板</p>
  {/if}
</section>

<style>
  .empty {
    color: var(--rem2-color-text-muted);
    font-family: var(--rem2-font-mono);
  }
</style>
