<script lang="ts">
  import { onMount } from 'svelte'
  import { appSettings } from '../../lib/stores/settings.svelte'
  import type {
    ProxyModeDto,
    ProxySettingsDto,
  } from '../../../shared/ipc-contract'

  let mode = $state<ProxyModeDto>('system')
  let address = $state('')
  let bypass = $state('')

  // The host is the source of truth: reload/save responses reset the form.
  $effect(() => {
    const proxy = appSettings.proxy
    mode = proxy.mode
    address = proxy.address ?? ''
    bypass = proxy.bypass ?? ''
  })

  const canSave = $derived(
    !appSettings.saving &&
      !appSettings.loading &&
      (mode !== 'manual' || address.trim().length > 0),
  )

  onMount(() => {
    void appSettings.load()
  })

  function save(event: SubmitEvent): void {
    event.preventDefault()
    if (!canSave) return
    const next: ProxySettingsDto = {
      mode,
      ...(mode === 'manual'
        ? {
            address: address.trim(),
            ...(bypass.trim().length > 0 ? { bypass: bypass.trim() } : {}),
          }
        : {}),
    }
    void appSettings.save(next)
  }
</script>

<section class="settings">
  <header class="header">
    <div>
      <h2>Settings</h2>
      <p>
        Network proxy used by Electron traffic and plugin downloads. Changes
        apply immediately.
      </p>
    </div>
    <button
      type="button"
      onclick={() => void appSettings.load()}
      disabled={appSettings.loading || appSettings.saving}
    >
      {appSettings.loading ? 'Reloading…' : 'Reload'}
    </button>
  </header>

  {#if appSettings.error}
    <p class="message error" role="alert">{appSettings.error}</p>
  {/if}
  {#if appSettings.notice}
    <p class="message notice">{appSettings.notice}</p>
  {/if}

  <form class="card" onsubmit={save}>
    <fieldset>
      <legend>Proxy mode</legend>
      <label for="proxy-mode">Mode</label>
      <select id="proxy-mode" bind:value={mode} disabled={appSettings.saving}>
        <option value="system">Use system proxy (default)</option>
        <option value="manual">Manual proxy</option>
        <option value="direct">Direct connection (no proxy)</option>
      </select>
      <p class="hint">
          System follows the operating system settings. Manual routes HTTP and
          HTTPS through the proxy below, using the scheme you enter.
      </p>
    </fieldset>

    {#if mode === 'manual'}
      <fieldset>
        <legend>Manual proxy</legend>
        <label for="proxy-address">Proxy address</label>
        <input
          id="proxy-address"
          type="text"
          bind:value={address}
          placeholder="http://127.0.0.1:7890"
          autocomplete="off"
          spellcheck="false"
          disabled={appSettings.saving}
        />
        <p class="hint">
          Accepts host:port, http://host:port or https://host:port. The port
          defaults to 80/443; the scheme is preserved.
        </p>

        <label for="proxy-bypass">Bypass list (optional)</label>
        <input
          id="proxy-bypass"
          type="text"
          bind:value={bypass}
          placeholder="localhost,127.0.0.1"
          autocomplete="off"
          spellcheck="false"
          disabled={appSettings.saving}
        />
        <p class="hint">
          Comma-separated hosts that connect directly, without the proxy.
        </p>
      </fieldset>
    {/if}

    {#if appSettings.proxy.resolved}
      <p class="status">
        Effective proxy: <code>{appSettings.proxy.resolved}</code>
      </p>
    {/if}

    <div class="actions">
      <button type="submit" class="primary" disabled={!canSave}>
        {appSettings.saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  </form>
</section>

<style>
  .settings {
    flex: 1;
    padding: var(--rem2-space-md);
    overflow: auto;
    min-height: 0;
  }
  .header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--rem2-space-md);
    margin-bottom: var(--rem2-space-md);
  }
  h2 {
    margin: 0;
    font-size: 16px;
  }
  .header p {
    margin: 4px 0 0;
    color: var(--rem2-color-text-muted);
    font-size: 13px;
  }
  .card {
    max-width: 560px;
    border: 1px solid var(--rem2-color-border);
    border-radius: 6px;
    padding: var(--rem2-space-md);
    background: var(--rem2-color-surface);
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0 0 var(--rem2-space-md);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  legend {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--rem2-color-text-muted);
    margin-bottom: 8px;
  }
  label {
    font-size: 13px;
    margin-top: 4px;
  }
  select,
  input {
    padding: 6px 8px;
    border: 1px solid var(--rem2-color-border);
    border-radius: 4px;
    background: var(--rem2-color-background);
    color: var(--rem2-color-text);
    font: inherit;
  }
  .hint {
    margin: 0;
    color: var(--rem2-color-text-muted);
    font-size: 12px;
  }
  .status {
    margin: 0 0 var(--rem2-space-md);
    font-size: 12px;
    color: var(--rem2-color-text-muted);
  }
  code {
    font-family: var(--rem2-font-mono);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
  }
  .primary {
    border-color: var(--rem2-color-accent);
  }
  .message {
    font-size: 13px;
    margin: 0 0 var(--rem2-space-sm);
  }
  .error {
    color: #ff6b6b;
  }
  .notice {
    color: var(--rem2-color-text-muted);
  }
</style>
