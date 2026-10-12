<!--
  命令输入框：调 command.execute（白名单方法之一）。

  骨架阶段只做结构：发出命令、显示最后一次结果，不做命令补全/历史导航。
-->
<script lang="ts">
  import { command } from '../../lib/stores/command.svelte';

  let input = $state('');

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    void command.execute(text);
    input = '';
  }

  let resultText = $derived.by(() => {
    const last = command.last;
    if (!last) return '';
    if (!last.ok) return last.error ?? 'failed';
    return last.output ?? 'ok';
  });
</script>

<form onsubmit={submit}>
  <input
    bind:value={input}
    placeholder="输入命令后回车"
    disabled={command.running}
  />
  <button type="submit" disabled={command.running || input.trim() === ''}>执行</button>
  {#if command.last}
    <span class="result" class:err={!command.last.ok}>{resultText}</span>
  {/if}
</form>

<style>
  form {
    display: flex;
    gap: var(--rem2-space-sm);
    align-items: center;
    flex: 1;
  }
  input {
    flex: 1;
    padding: var(--rem2-space-xs) var(--rem2-space-sm);
    background: var(--rem2-color-surface);
    color: var(--rem2-color-text);
    border: 1px solid var(--rem2-color-border);
    border-radius: 4px;
    font: inherit;
  }
  button {
    padding: var(--rem2-space-xs) var(--rem2-space-md);
    background: var(--rem2-color-accent);
    color: var(--rem2-color-background);
    border: 0;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .result {
    font-family: var(--rem2-font-mono);
    font-size: 12px;
    color: var(--rem2-color-text-muted);
  }
  .result.err {
    color: #ff6b6b;
  }
</style>
