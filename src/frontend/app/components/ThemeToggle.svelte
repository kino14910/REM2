<!-- 主题切换：读主题列表，发 ui.theme.set。 -->
<script lang="ts">
  import { theme } from '../../lib/stores/theme.svelte';
</script>

{#if theme.list.length > 0}
  <select
    value={theme.activeId ?? ''}
    onchange={(e) => {
      const id = e.currentTarget.value;
      const t = theme.list.find((x) => x.id === id);
      if (t) theme.setActive(t);
    }}
  >
    {#each theme.list as t (t.id)}
      <option value={t.id}>{t.id}</option>
    {/each}
  </select>
{/if}

<style>
  select {
    background: var(--rem2-color-surface);
    color: var(--rem2-color-text);
    border: 1px solid var(--rem2-color-border);
    border-radius: 4px;
    padding: var(--rem2-space-xs) var(--rem2-space-sm);
    font: inherit;
  }
</style>
