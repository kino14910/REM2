<!--
  单面板的 chrome（标题栏 + 内容区 + 空态）。

  它**不关心内容语义**：插件只贡献 `PanelDto`（声明式描述），
  数据由主进程按 `panel.command` 走事件总线取回，形状由插件自定。
-->
<script lang="ts">
  import { ipc } from '../../lib/ipc-client';
  import { channels } from '../../lib/channels';
  import type { PanelDto } from '../../lib/bridge-types';

  let { panel }: { panel: PanelDto } = $props();

  let data = $state<unknown>(undefined);
  let loading = $state<boolean>(false);
  let error = $state<string | undefined>(undefined);

  // 面板切换时重新取数。
  $effect(() => {
    const panelId = panel.panelId;
    loading = true;
    void ipc
      .request(channels.panelData, { panelId })
      .then((d) => {
        data = d;
        error = undefined;
      })
      .catch((e: Error) => {
        error = e.message;
      })
      .finally(() => {
        loading = false;
      });
  });

  function report(kind: string, payload?: unknown): void {
    void ipc.request(channels.uiEvent, { panelId: panel.panelId, kind, payload });
  }
</script>

<section class="panel">
  <header class="panel-head">
    <span class="icon">{panel.icon}</span>
    <h2>{panel.title}</h2>
    <button type="button" onclick={() => report('refresh')}>刷新</button>
  </header>
  <div class="panel-body">
    {#if loading}
      <p class="muted">加载中…</p>
    {:else if error}
      <p class="error">{error}</p>
    {:else if data === undefined}
      <p class="muted">该面板未提供数据</p>
    {:else}
      <pre>{JSON.stringify(data, null, 2)}</pre>
    {/if}
  </div>
</section>

<style>
  .panel {
    border: 1px solid var(--rem2-color-border);
    border-radius: 6px;
    background: var(--rem2-color-surface);
  }
  .panel-head {
    display: flex;
    gap: var(--rem2-space-sm);
    align-items: center;
    padding: var(--rem2-space-sm) var(--rem2-space-md);
    border-bottom: 1px solid var(--rem2-color-border);
  }
  .panel-head h2 {
    margin: 0;
    font-size: 14px;
    flex: 1;
  }
  .panel-body {
    padding: var(--rem2-space-md);
  }
  pre {
    margin: 0;
    font-family: var(--rem2-font-mono);
    font-size: 12px;
    white-space: pre-wrap;
  }
  .muted {
    color: var(--rem2-color-text-muted);
    margin: 0;
  }
  .error {
    color: var(--rem2-color-text);
    margin: 0;
  }
</style>
