<!--
  Light/dark switch.

  Rendered only when the catalog holds both modes (`theme.canSwitchMode`), i.e. only
  while a plugin that contributes both token sets is loaded. A single-mode catalog
  leaves nothing to switch to, so the host chrome stays empty instead of showing a
  dead control.
-->
<script lang="ts">
  import { theme } from '../../lib/stores/theme.svelte'
</script>

{#if theme.canSwitchMode}
  <div class="mode-switch" role="group" aria-label="Color mode">
    <button
      type="button"
      class="mode-switch__option"
      aria-label="Light mode"
      aria-pressed={theme.active?.mode === 'light'}
      onclick={() => theme.setMode('light')}
    >
      <svg
        viewBox="0 0 16 16"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="3" />
        <path
          d="M8 1.4v1.5M8 13.1v1.5M1.4 8h1.5M13.1 8h1.5M3.3 3.3l1.1 1.1M11.6 11.6l1.1 1.1M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1"
        />
      </svg>
    </button>
    <button
      type="button"
      class="mode-switch__option"
      aria-label="Dark mode"
      aria-pressed={theme.active?.mode === 'dark'}
      onclick={() => theme.setMode('dark')}
    >
      <svg
        viewBox="0 0 16 16"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M13.2 9.7A5.6 5.6 0 0 1 6.3 2.8a5.6 5.6 0 1 0 6.9 6.9Z" />
      </svg>
    </button>
  </div>
{/if}

<style>
  .mode-switch {
    display: inline-flex;
    border: 1px solid var(--rem2-color-border);
    border-radius: 6px;
    background: var(--rem2-color-surface);
    overflow: hidden;
  }

  .mode-switch__option {
    display: inline-flex;
    align-items: center;
    padding: var(--rem2-space-xs) var(--rem2-space-sm);
    border: 0;
    background: transparent;
    color: var(--rem2-color-text-muted);
    cursor: pointer;
  }

  .mode-switch__option:hover {
    color: var(--rem2-color-text);
  }

  .mode-switch__option[aria-pressed='true'] {
    background: var(--rem2-color-accent);
    /* Inverted against the accent: readable on both palettes without a third token. */
    color: var(--rem2-color-background);
  }

  .mode-switch__option:focus-visible {
    outline: 2px solid var(--rem2-color-accent);
    outline-offset: -2px;
  }
</style>
