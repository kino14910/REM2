<script lang="ts">
  import { onMount } from 'svelte'
  import { plugins } from '../../lib/stores/plugins.svelte'
  import { ipc } from '../../lib/ipc-client'
  import { events } from '../../../shared/ipc-contract'
  import type { PluginDetailDto } from '../../../shared/ipc-contract'

  const confirmationPlugin = $derived(
    plugins.items.find(item => item.id === plugins.confirmation?.pluginId),
  )
  const pendingPlugins = $derived(
    plugins.items.filter(item => item.restartRequired),
  )
  const activeUpdates = $derived(
    plugins.updates.filter(update => update.hasUpdate),
  )
  const updateTargetEntry = $derived(
    plugins.updates.find(update => update.pluginId === updateTarget),
  )
  const updateTargetPlugin = $derived(
    plugins.items.find(item => item.id === updateTarget),
  )
  let showPending = $state(false)
  let showRemote = $state(false)
  let showUpdates = $state(false)
  let remoteUrl = $state('')
  let updateTarget = $state<string | undefined>(undefined)
  let dialogEl = $state<HTMLDivElement | undefined>(undefined)
  let remoteDialogEl = $state<HTMLDivElement | undefined>(undefined)
  let updatesDialogEl = $state<HTMLDivElement | undefined>(undefined)

  // The dialog must not outlive its content (e.g. after a restart).
  $effect(() => {
    if (showPending && pendingPlugins.length === 0) showPending = false
  })

  $effect(() => {
    if (showPending) dialogEl?.focus()
  })

  $effect(() => {
    if (showRemote) remoteDialogEl?.focus()
  })

  $effect(() => {
    if (showUpdates) updatesDialogEl?.focus()
  })

  function closePending(): void {
    showPending = false
  }

  function closeRemote(): void {
    if (plugins.remotePending) return
    showRemote = false
    plugins.dismissRemote()
  }

  function closeUpdates(): void {
    if (plugins.remotePending) return
    showUpdates = false
    updateTarget = undefined
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    if (updateTarget) updateTarget = undefined
    else if (showRemote) closeRemote()
    else if (showUpdates) closeUpdates()
    else if (showPending) closePending()
  }

  function stopPropagation(event: MouseEvent): void {
    event.stopPropagation()
  }

  /** Progress events are only meaningful while a remote operation is running. */
  const remoteBusy = $derived(
    plugins.remotePending === 'inspecting' ||
      plugins.remotePending === 'installing' ||
      plugins.remotePending === 'updating',
  )

  function formatBytes(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0 B'
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`
    return `${value} B`
  }

  function progressLabel(): string {
    const progress = plugins.progress
    if (!progress) return 'Starting…'
    const received = progress.receivedBytes
    const total = progress.totalBytes
    if (received !== undefined && total !== undefined && total > 0) {
      return `${formatBytes(received)} / ${formatBytes(total)}`
    }
    return received !== undefined ? formatBytes(received) : phaseLabel()
  }

  function phaseLabel(): string {
    switch (plugins.progress?.phase) {
      case 'downloading':
        return 'Downloading…'
      case 'verifying':
        return 'Verifying SHA-256…'
      case 'extracting':
        return 'Extracting…'
      case 'installing':
        return 'Installing…'
      default:
        return 'Starting…'
    }
  }

  function progressPercent(): number {
    const progress = plugins.progress
    if (!progress?.totalBytes || progress.receivedBytes === undefined) {
      return 0
    }
    return Math.min(
      100,
      Math.round((progress.receivedBytes / progress.totalBytes) * 100),
    )
  }

  function notesSummary(notes: string | undefined): string {
    if (!notes) return ''
    const single = notes.replace(/\s+/g, ' ').trim()
    return single.length > 140 ? `${single.slice(0, 140)}…` : single
  }

  onMount(() => {
    void plugins.load()
    const offProgress = plugins.subscribeProgress()
    // Coalesce: a plugin-service restart emits one event per plugin, and the
    // action handler already reloads afterwards.
    let reloadTimer: ReturnType<typeof setTimeout> | undefined
    const off = ipc.subscribe(events.pluginStateChanged, () => {
      if (reloadTimer !== undefined) return
      reloadTimer = setTimeout(() => {
        reloadTimer = undefined
        void plugins.load()
      }, 80)
    })
    return () => {
      off()
      offProgress()
      if (reloadTimer !== undefined) clearTimeout(reloadTimer)
    }
  })

  function canDisable(plugin: PluginDetailDto): boolean {
    return plugin.enabled && ['Active', 'Degraded', 'Loaded', 'Initialized', 'Configured'].includes(plugin.state)
  }

  function enableLabel(plugin: PluginDetailDto): string {
    if (plugins.pending?.action === 'enable' && plugins.pending.pluginId === plugin.id) {
      return 'Enabling…'
    }
    return plugin.state === 'Failed' || plugin.state === 'Dropped' ? 'Retry' : 'Enable'
  }
</script>

<svelte:window onkeydown={onKeydown} />

<section class="manager">
  <header class="toolbar">
    <div>
      <h2>Plugin management</h2>
      <p>Install a built plugin folder. New installs stay disabled until explicitly enabled.</p>
    </div>
    <div class="toolbar-actions">
      <button type="button" onclick={() => void plugins.load()} disabled={plugins.loading}>
        {plugins.loading ? 'Refreshing…' : 'Refresh'}
      </button>
      <button
        type="button"
        onclick={() => {
          showUpdates = true
          void plugins.checkUpdates()
        }}
        disabled={!!plugins.remotePending}
      >
        {plugins.remotePending === 'checking' ? 'Checking…' : 'Check updates'}
        {#if activeUpdates.length > 0}<span class="badge">{activeUpdates.length}</span>{/if}
      </button>
      <button
        type="button"
        onclick={() => (showRemote = true)}
        disabled={!!plugins.remotePending}
      >
        Install from URL…
      </button>
      <button
        type="button"
        class="primary"
        onclick={() => void plugins.installFromDirectory()}
        disabled={!!plugins.pending}
      >
        {plugins.pending?.action === 'installFromDirectory' ? 'Installing…' : 'Install from folder…'}
      </button>
    </div>
  </header>

  {#if plugins.loadError}
    <div class="message error" role="alert">
      <span>{plugins.loadError}</span>
      <button type="button" onclick={() => void plugins.load()}>Retry</button>
    </div>
  {/if}
  {#if plugins.actionError}
    <p class="message error" role="alert">{plugins.actionError}</p>
  {/if}
  {#if plugins.notice}
    <p class="message notice">{plugins.notice}</p>
  {/if}
  {#if plugins.restartRequired}
    <div class="message warning" role="status">
      <span>
        Restart the plugin service to apply
        <button type="button" class="link" onclick={() => (showPending = true)}>
          pending changes
        </button>.
      </span>
      <button
        type="button"
        onclick={() => void plugins.restart()}
        disabled={!!plugins.pending}
      >
        {plugins.pending?.action === 'restart' ? 'Restarting…' : 'Restart plugins'}
      </button>
    </div>
  {/if}

  {#if showPending}
    <!-- Backdrop click closes; clicks inside the dialog stop at the panel. -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="backdrop" role="presentation" onclick={closePending}>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pending-title"
        tabindex="-1"
        bind:this={dialogEl}
        onclick={stopPropagation}
      >
        <h3 id="pending-title">Pending changes</h3>
        <p class="muted">
          These plugins are disabled on disk but still running. Restart the
          plugin service to stop them.
        </p>
        <ul class="pending-list">
          {#each pendingPlugins as plugin (plugin.id)}
            <li>
              <span class="plugin-name">{plugin.name}</span>
              <code>{plugin.id}</code>
              <span class="state" data-state={plugin.state}>{plugin.state}</span>
            </li>
          {/each}
        </ul>
        <div class="actions">
          <button type="button" onclick={closePending}>Close</button>
          <button
            type="button"
            class="primary"
            onclick={() => void plugins.restart()}
            disabled={!!plugins.pending}
          >
            {plugins.pending?.action === 'restart' ? 'Restarting…' : 'Restart plugins'}
          </button>
        </div>
      </div>
    </div>
  {/if}
  {#if plugins.issues.length > 0}
    <details class="issues">
      <summary>{plugins.issues.length} discovery or validation issue(s)</summary>
      {#each plugins.issues as issue}
        <p>{issue}</p>
      {/each}
    </details>
  {/if}

  {#if showRemote}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="backdrop" role="presentation" onclick={closeRemote}>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div
        class="dialog wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-title"
        tabindex="-1"
        bind:this={remoteDialogEl}
        onclick={stopPropagation}
      >
        <h3 id="remote-title">Install from URL</h3>
        <p class="muted">
          Only HTTPS release URLs on the allowlist (GitHub) are accepted. The
          package is downloaded and inspected first; nothing is installed or
          executed until you confirm.
        </p>
        <label class="field">
          <span>Release URL</span>
          <input
            bind:value={remoteUrl}
            placeholder="https://github.com/owner/repo/releases/tag/v1.0.0"
            disabled={!!plugins.remotePending}
          />
        </label>
        <div class="actions">
          <button
            type="button"
            onclick={closeRemote}
            disabled={!!plugins.remotePending}
          >
            Close
          </button>
          <button
            type="button"
            class="primary"
            onclick={() => void plugins.inspectRemote(remoteUrl.trim())}
            disabled={!remoteUrl.trim() || !!plugins.remotePending}
          >
            {plugins.remotePending === 'inspecting' ? 'Inspecting…' : 'Inspect'}
          </button>
        </div>

        {#if remoteBusy || plugins.cancelling}
          <div class="progress" role="status">
            <div class="progress-meta">
              <span>{phaseLabel()}</span>
              <span>{progressLabel()}</span>
            </div>
            <div class="progress-track">
              <div
                class="progress-fill"
                style:width={`${progressPercent()}%`}
              ></div>
            </div>
            {#if plugins.remotePending !== 'updating'}
              <button
                type="button"
                onclick={() => void plugins.cancelDownload()}
                disabled={plugins.cancelling}
              >
                {plugins.cancelling ? 'Cancelling…' : 'Cancel download'}
              </button>
            {/if}
          </div>
        {/if}

        {#if plugins.remoteError}
          <p class="message error" role="alert">{plugins.remoteError}</p>
        {/if}

        {#if plugins.inspection}
          {@const inspection = plugins.inspection}
          <section class="preview">
            <h4>Package preview</h4>
            <dl class="metadata">
              <dt>Source</dt><dd><code>{inspection.url}</code></dd>
              <dt>Asset</dt><dd><code>{inspection.downloadUrl}</code></dd>
              <dt>Id</dt><dd><code>{inspection.id}</code></dd>
              <dt>Name</dt><dd>{inspection.name}</dd>
              <dt>Version</dt><dd>{inspection.version}</dd>
              {#if inspection.publishedAt}
                <dt>Published</dt><dd>{inspection.publishedAt}</dd>
              {/if}
              {#if inspection.size !== undefined}
                <dt>Size</dt><dd>{formatBytes(inspection.size)}</dd>
              {/if}
              <dt>SHA-256</dt>
              <dd>
                {#if inspection.sha256}
                  <code class="digest">{inspection.sha256}</code>
                  <span class="trusted">from release metadata</span>
                {:else}
                  <span class="warning">Not published</span>
                {/if}
              </dd>
            </dl>
            {#if inspection.notes}
              <p class="notes">{notesSummary(inspection.notes)}</p>
            {/if}
            <div class="requirements">
              <section>
                <h4>Declared capabilities</h4>
                {#each inspection.requires as capability}
                  <p><code>{capability}</code></p>
                {:else}<p class="muted">None</p>{/each}
              </section>
              <section>
                <h4>Dependencies</h4>
                {#each Object.entries(inspection.dependencies) as [id, range]}
                  <p><code>{id}</code> <span>{range}</span></p>
                {:else}<p class="muted">None</p>{/each}
              </section>
            </div>
            <p class="disclaimer">
              Declared capabilities are permissions, not a sandbox. SHA-256 only
              proves integrity, not who published the package: there is no
              signature verification.
            </p>
            {#if !inspection.sha256}
              <p class="message error" role="alert">
                The publisher did not provide a SHA-256 digest, so installation
                is blocked.
              </p>
            {/if}
            <div class="actions">
              <button
                type="button"
                class="primary"
                onclick={() => void plugins.installRemote()}
                disabled={!inspection.sha256 || !!plugins.remotePending}
              >
                {plugins.remotePending === 'installing'
                  ? 'Installing…'
                  : 'Confirm install'}
              </button>
            </div>
          </section>
        {/if}
      </div>
    </div>
  {/if}

  {#if showUpdates}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="backdrop" role="presentation" onclick={closeUpdates}>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div
        class="dialog wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="updates-title"
        tabindex="-1"
        bind:this={updatesDialogEl}
        onclick={stopPropagation}
      >
        <h3 id="updates-title">Plugin updates</h3>
        <p class="muted">
          Installed remote plugins are compared with their recorded release
          source. Nothing installs until you confirm a specific version.
        </p>
        {#if plugins.updateError}
          <p class="message error" role="alert">{plugins.updateError}</p>
        {/if}
        {#if plugins.remotePending === 'checking'}
          <p class="muted">Checking…</p>
        {:else if activeUpdates.length === 0}
          <p class="muted">No updates available.</p>
        {:else}
          <ul class="update-list">
            {#each activeUpdates as update (update.pluginId)}
              <li>
                <div>
                  <strong>
                    {plugins.items.find((item) => item.id === update.pluginId)
                      ?.name ?? update.pluginId}
                  </strong>
                  <code>{update.pluginId}</code>
                  <p class="version">
                    {update.currentVersion} → {update.latestVersion}
                  </p>
                  {#if update.publishedAt}
                    <p class="muted">Published {update.publishedAt}</p>
                  {/if}
                  {#if update.notes}
                    <p class="muted">{notesSummary(update.notes)}</p>
                  {/if}
                </div>
                <button
                  type="button"
                  onclick={() => (updateTarget = update.pluginId)}
                  disabled={!!plugins.remotePending}
                >
                  Update
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        <div class="actions">
          <button
            type="button"
            onclick={closeUpdates}
            disabled={!!plugins.remotePending}
          >
            Close
          </button>
          <button
            type="button"
            onclick={() => void plugins.checkUpdates()}
            disabled={!!plugins.remotePending}
          >
            Re-check
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if updateTargetEntry}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="backdrop" role="presentation" onclick={() => (updateTarget = undefined)}>
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-title"
        tabindex="-1"
        onclick={stopPropagation}
      >
        <h3 id="update-title">Update plugin</h3>
        <p>
          Update
          <strong>{updateTargetPlugin?.name ?? updateTargetEntry.pluginId}</strong>
          from <code>{updateTargetEntry.currentVersion}</code> to
          <code>{updateTargetEntry.latestVersion}</code>?
        </p>
        <dl class="metadata">
          <dt>Source</dt><dd><code>{updateTargetEntry.url}</code></dd>
          <dt>SHA-256</dt>
          <dd>
            {#if updateTargetEntry.sha256}
              <code class="digest">{updateTargetEntry.sha256}</code>
            {:else}
              <span class="warning">Not published — update blocked</span>
            {/if}
          </dd>
          <dt>Capabilities</dt>
          <dd>
            {#each updateTargetPlugin?.requires ?? [] as capability}
              <code>{capability}</code>
            {:else}<span class="muted">None declared</span>{/each}
          </dd>
        </dl>
        {#if remoteBusy || plugins.cancelling}
          <div class="progress" role="status">
            <div class="progress-meta">
              <span>{phaseLabel()}</span>
              <span>{progressLabel()}</span>
            </div>
            <div class="progress-track">
              <div
                class="progress-fill"
                style:width={`${progressPercent()}%`}
              ></div>
            </div>
          </div>
        {/if}
        <p class="disclaimer">
          The old version is backed up and restored automatically if the update
          fails. SHA-256 proves integrity only; it does not prove who published
          this package.
        </p>
        <div class="actions">
          <button
            type="button"
            onclick={() => (updateTarget = undefined)}
            disabled={!!plugins.remotePending}
          >
            Cancel
          </button>
          <button
            type="button"
            class="primary"
            onclick={() => {
              const pluginId = updateTarget
              updateTarget = undefined
              if (pluginId) void plugins.applyUpdate(pluginId)
            }}
            disabled={!updateTargetEntry.sha256 || !!plugins.remotePending}
          >
            Confirm update
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if plugins.confirmation}
    <div class="confirm" role="alertdialog" aria-label="Confirm plugin operation">
      <p>
        Uninstall
        <strong>{confirmationPlugin?.name ?? plugins.confirmation.pluginId}</strong>?
        Configuration and plugin data will be preserved.
      </p>
      <button type="button" onclick={() => plugins.cancelConfirmation()}>Cancel</button>
      <button type="button" class="danger" onclick={() => void plugins.confirm()}>
        Confirm uninstall
      </button>
    </div>
  {/if}

  {#if plugins.loading && plugins.items.length === 0 && !plugins.loadError}
    <div class="empty">Loading plugins…</div>
  {:else if plugins.items.length === 0 && !plugins.loadError}
    <div class="empty">
      <p>No plugins installed.</p>
      <button
        type="button"
        class="primary"
        onclick={() => void plugins.installFromDirectory()}
        disabled={!!plugins.pending}
      >
        Install from folder…
      </button>
    </div>
  {:else if plugins.items.length > 0}
    <div class="content">
      <div class="list" aria-label="Installed plugins">
        {#each plugins.items as plugin (plugin.id)}
          <button
            type="button"
            class="plugin-row"
            class:selected={plugin.id === plugins.selectedId}
            onclick={() => plugins.select(plugin.id)}
          >
            <span class="plugin-name">{plugin.name}</span>
            <span class="plugin-id">{plugin.id}</span>
            <span class="row-meta">
              <span>{plugin.version}</span>
              <span class="state" data-state={plugin.state}>{plugin.state}</span>
            </span>
          </button>
        {/each}
      </div>

      <div class="detail">
        {#if plugins.selected}
          {@const selected = plugins.selected}
          <header class="detail-head">
            <div>
              <h3>{selected.name}</h3>
              <code>{selected.id}</code>
            </div>
            <span class="state" data-state={selected.state}>{selected.state}</span>
          </header>

          {#if selected.description}
            <p>{selected.description}</p>
          {/if}
          {#if selected.error}
            <p class="message error">{selected.error}</p>
          {/if}

          <dl class="metadata">
            <dt>Version</dt><dd>{selected.version}</dd>
            <dt>Source</dt><dd>{selected.source}</dd>
            {#if selected.origin}
              <dt>Origin</dt>
              <dd>
                {#if selected.origin.kind === 'remote'}
                  <code>{selected.origin.url}</code>
                  {#if selected.origin.sha256}
                    <p class="muted">
                      sha256 {selected.origin.sha256.slice(0, 12)}…
                    </p>
                  {/if}
                {:else}
                  Local directory
                {/if}
              </dd>
            {/if}
            <dt>Entry</dt><dd><code>{selected.entry}</code></dd>
            <dt>Kernel</dt><dd>{selected.compatibility.minKernel}</dd>
            <dt>Contract</dt><dd>{selected.compatibility.contractVersion}</dd>
            {#if selected.author}<dt>Author</dt><dd>{selected.author}</dd>{/if}
          </dl>

          <div class="requirements">
            <section>
              <h4>Dependencies</h4>
              {#each Object.entries(selected.dependencies) as [id, range]}
                <p><code>{id}</code> <span>{range}</span></p>
              {:else}<p class="muted">None</p>{/each}
            </section>
            <section>
              <h4>Required capabilities</h4>
              {#each selected.requires as capability}
                <p>
                  <code>{capability}</code>
                  {#if !selected.builtin}
                    <span
                      class:denied={selected.permissions.denied.includes(
                        capability,
                      )}
                      class:granted={selected.permissions.granted.includes(
                        capability,
                      )}
                    >
                      {selected.permissions.denied.includes(capability)
                        ? 'denied'
                        : 'granted'}
                    </span>
                  {/if}
                </p>
              {:else}<p class="muted">None</p>{/each}
              {#if !selected.builtin && selected.permissions.denied.length > 0}
                <button
                  type="button"
                  onclick={() =>
                    void plugins.grant(
                      selected.id,
                      selected.permissions.denied,
                    )}
                  disabled={!!plugins.pending}
                >
                  {plugins.pending?.action === 'grant' &&
                  plugins.pending.pluginId === selected.id
                    ? 'Granting…'
                    : 'Grant denied capabilities'}
                </button>
                <p class="muted">
                  The sandbox denies sensitive capabilities by default. Grants
                  apply on the next start.
                </p>
              {/if}
            </section>
          </div>

          <div class="actions">
            {#if canDisable(selected)}
              <button
                type="button"
                onclick={() => void plugins.disable(selected.id)}
                disabled={!!plugins.pending}
              >
                {plugins.pending?.action === 'disable' && plugins.pending.pluginId === selected.id ? 'Disabling…' : 'Disable'}
              </button>
            {:else}
              <button
                type="button"
                class="primary"
                onclick={() => void plugins.enable(selected.id)}
                disabled={!!plugins.pending}
              >
                {enableLabel(selected)}
              </button>
            {/if}
            {#if selected.canUninstall}
              <button
                type="button"
                class="danger"
                onclick={() => plugins.requestUninstall(selected.id)}
                disabled={!!plugins.pending}
              >
                {plugins.pending?.action === 'uninstall' && plugins.pending.pluginId === selected.id ? 'Uninstalling…' : 'Uninstall'}
              </button>
            {/if}
          </div>
        {:else}
          <div class="empty">Select a plugin to view details.</div>
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .manager { display: flex; flex-direction: column; gap: var(--rem2-space-md); padding: var(--rem2-space-md); min-height: 0; flex: 1; overflow: auto; }
  .toolbar, .toolbar-actions, .detail-head, .actions, .confirm { display: flex; align-items: center; gap: var(--rem2-space-sm); }
  .toolbar, .detail-head { justify-content: space-between; }
  h2, h3, h4, p { margin-top: 0; }
  h2 { margin-bottom: var(--rem2-space-xs); font-size: 18px; }
  h3 { margin-bottom: var(--rem2-space-xs); font-size: 16px; }
  h4 { margin-bottom: var(--rem2-space-sm); font-size: 12px; color: var(--rem2-color-text-muted); }
  .toolbar p { margin-bottom: 0; color: var(--rem2-color-text-muted); font-size: 12px; }
  button { padding: 6px 10px; border: 1px solid var(--rem2-color-border); border-radius: 4px; background: var(--rem2-color-surface); color: var(--rem2-color-text); font: inherit; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  button.primary { border-color: var(--rem2-color-accent); }
  button.danger, .error { color: #ff6b6b; }
  .message { margin: 0; padding: var(--rem2-space-sm); border: 1px solid var(--rem2-color-border); border-radius: 4px; }
  .message.error { display: flex; justify-content: space-between; align-items: center; }
  .message.warning { display: flex; align-items: center; gap: var(--rem2-space-sm); }
  .message.warning span { flex: 1; }
  .notice { color: var(--rem2-color-accent); }
  .warning { color: #e5c07b; }
  .issues { color: var(--rem2-color-text-muted); font-size: 12px; }
  .issues p { margin: var(--rem2-space-xs) 0; }
  .confirm { padding: var(--rem2-space-md); border: 1px solid #e5c07b; border-radius: 4px; }
  .confirm p { flex: 1; margin: 0; }
  .content { display: grid; grid-template-columns: minmax(220px, 300px) 1fr; gap: var(--rem2-space-md); min-height: 0; }
  .list { display: flex; flex-direction: column; gap: var(--rem2-space-xs); }
  .plugin-row { display: flex; flex-direction: column; align-items: stretch; gap: 3px; text-align: left; }
  .plugin-row.selected { border-color: var(--rem2-color-accent); background: var(--rem2-color-background); }
  .plugin-name { font-weight: 600; }
  .plugin-id { color: var(--rem2-color-text-muted); font: 11px var(--rem2-font-mono); overflow-wrap: anywhere; }
  .row-meta { display: flex; justify-content: space-between; color: var(--rem2-color-text-muted); font-size: 11px; }
  .state { padding: 1px 5px; border: 1px solid var(--rem2-color-border); border-radius: 3px; color: var(--rem2-color-text-muted); font-size: 11px; }
  .state[data-state='Active'] { color: #98c379; }
  .state[data-state='Failed'], .state[data-state='Dropped'] { color: #ff6b6b; }
  .state[data-state='Degraded'] { color: #e5c07b; }
  .detail { padding: var(--rem2-space-md); border: 1px solid var(--rem2-color-border); border-radius: 6px; background: var(--rem2-color-surface); }
  code { font-family: var(--rem2-font-mono); overflow-wrap: anywhere; }
  .metadata { display: grid; grid-template-columns: 90px 1fr; gap: var(--rem2-space-xs) var(--rem2-space-md); font-size: 12px; }
  .metadata dt { color: var(--rem2-color-text-muted); }
  .metadata dd { margin: 0; }
  .requirements { display: grid; grid-template-columns: 1fr 1fr; gap: var(--rem2-space-md); }
  .requirements p { margin-bottom: var(--rem2-space-xs); font-size: 12px; }
  .requirements p span { color: var(--rem2-color-text-muted); }
  .requirements .granted { color: #98c379; }
  .requirements .denied { color: #e5c07b; }
  .muted { color: var(--rem2-color-text-muted); }
  button.link { padding: 0; border: none; background: none; color: var(--rem2-color-accent); text-decoration: underline; font: inherit; }
  .backdrop { position: fixed; inset: 0; z-index: 10; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.55); }
  .dialog { width: min(420px, calc(100vw - 32px)); max-height: 70vh; overflow: auto; padding: var(--rem2-space-md); border: 1px solid var(--rem2-color-border); border-radius: 6px; background: var(--rem2-color-surface); color: var(--rem2-color-text); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35); }
  .dialog h3 { margin-bottom: var(--rem2-space-xs); }
  .dialog:focus { outline: none; }
  .dialog p { margin-bottom: var(--rem2-space-sm); font-size: 12px; }
  .pending-list { display: flex; flex-direction: column; gap: var(--rem2-space-xs); margin: 0 0 var(--rem2-space-md); padding: 0; list-style: none; }
  .pending-list li { display: flex; align-items: center; gap: var(--rem2-space-sm); padding: var(--rem2-space-xs) 0; border-bottom: 1px solid var(--rem2-color-border); font-size: 12px; }
  .pending-list li:last-child { border-bottom: none; }
  .pending-list .plugin-name { flex: 1; font-weight: 600; }
  .pending-list code { color: var(--rem2-color-text-muted); font-size: 11px; }
  .actions { padding-top: var(--rem2-space-md); border-top: 1px solid var(--rem2-color-border); }
  .empty { padding: var(--rem2-space-lg); text-align: center; color: var(--rem2-color-text-muted); }
  .badge { margin-left: 4px; padding: 0 4px; border: 1px solid var(--rem2-color-accent); border-radius: 8px; color: var(--rem2-color-accent); font-size: 10px; }
  .dialog.wide { width: min(640px, calc(100vw - 32px)); }
  .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: var(--rem2-space-sm); font-size: 12px; }
  .field span { color: var(--rem2-color-text-muted); }
  .field input { padding: 6px 8px; border: 1px solid var(--rem2-color-border); border-radius: 4px; background: var(--rem2-color-background); color: var(--rem2-color-text); font: 12px var(--rem2-font-mono); }
  .preview { margin-top: var(--rem2-space-md); padding-top: var(--rem2-space-md); border-top: 1px solid var(--rem2-color-border); }
  .digest { font-size: 11px; }
  .trusted { display: block; color: #98c379; font-size: 11px; }
  .notes { font-size: 12px; color: var(--rem2-color-text-muted); }
  .disclaimer { font-size: 11px; color: #e5c07b; }
  .progress { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin-top: var(--rem2-space-sm); }
  .progress-meta { display: flex; justify-content: space-between; width: 100%; font-size: 12px; color: var(--rem2-color-text-muted); }
  .progress-track { width: 100%; height: 6px; border: 1px solid var(--rem2-color-border); border-radius: 3px; background: var(--rem2-color-background); overflow: hidden; }
  .progress-fill { height: 100%; background: var(--rem2-color-accent); transition: width 120ms linear; }
  .update-list { display: flex; flex-direction: column; gap: var(--rem2-space-sm); margin: 0; padding: 0; list-style: none; }
  .update-list li { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--rem2-space-sm); padding: var(--rem2-space-sm); border: 1px solid var(--rem2-color-border); border-radius: 4px; }
  .update-list li p { margin: 2px 0 0; font-size: 12px; }
  .update-list .version { color: var(--rem2-color-accent); }
  @media (max-width: 760px) { .content, .requirements { grid-template-columns: 1fr; } }
</style>
