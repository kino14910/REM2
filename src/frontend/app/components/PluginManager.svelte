<script lang="ts">
  import { onMount } from 'svelte'
  import { plugins } from '@/frontend/lib/stores/plugins.svelte'
  import { ipc } from '@/frontend/lib/ipc-client'
  import { events } from '@/shared/ipc-contract'
  import type {
    PluginDetailDto,
    PluginMarketEntryDto,
  } from '@/shared/ipc-contract'
  import PluginMarketDetail from '@/frontend/app/components/PluginMarketDetail.svelte'
  import Alert from '@/frontend/lib/ui/Alert.svelte'
  import Badge from '@/frontend/lib/ui/Badge.svelte'
  import Button from '@/frontend/lib/ui/Button.svelte'
  import Card from '@/frontend/lib/ui/Card.svelte'
  import Dialog from '@/frontend/lib/ui/Dialog.svelte'
  import EmptyState from '@/frontend/lib/ui/EmptyState.svelte'
  import Field from '@/frontend/lib/ui/Field.svelte'
  import IconButton from '@/frontend/lib/ui/IconButton.svelte'
  import Menu from '@/frontend/lib/ui/Menu.svelte'
  import Progress from '@/frontend/lib/ui/Progress.svelte'
  import TextField from '@/frontend/lib/ui/TextField.svelte'
  import { cn } from '@/frontend/lib/ui/cn'
  import type { BadgeTone, MenuItem } from '@/frontend/lib/ui/types'

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
  let query = $state('')
  let remoteUrl = $state('')
  let updateTarget = $state<string | undefined>(undefined)
  let grantTargetId = $state<string | undefined>(undefined)

  const searchActive = $derived(query.trim() !== '')
  const marketById = $derived(
    new Map(plugins.marketItems.map(entry => [entry.id, entry])),
  )
  const installedIds = $derived(
    new Set(plugins.items.map(item => item.id)),
  )
  /** Marketplace entries already shown as installed rows are not duplicated. */
  const marketOnly = $derived(
    plugins.marketItems.filter(entry => !installedIds.has(entry.id)),
  )
  const selectedMarket = $derived(
    plugins.selectedId === undefined
      ? undefined
      : marketById.get(plugins.selectedId),
  )

  const filteredPlugins = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return plugins.items
    return plugins.items.filter(item =>
      `${item.name} ${item.id} ${item.description ?? ''} ${item.tags.join(' ')}`
        .toLowerCase()
        .includes(needle),
    )
  })

  const filteredMarket = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return marketOnly
    return marketOnly.filter(entry =>
      `${entry.name} ${entry.id} ${entry.description} ${entry.tags.join(' ')}`
        .toLowerCase()
        .includes(needle),
    )
  })

  const noSearchResults = $derived(
    searchActive &&
      filteredPlugins.length === 0 &&
      filteredMarket.length === 0 &&
      !plugins.loading &&
      !plugins.marketLoading &&
      !plugins.loadError &&
      !plugins.marketLoadError,
  )
  const marketBusy = $derived(
    Boolean(plugins.marketPending || plugins.remotePending || plugins.pending),
  )

  const grantTarget = $derived(
    plugins.items.find(item => item.id === grantTargetId),
  )
  const grantDenied = $derived(
    grantTarget ? deniedCapabilities(grantTarget) : [],
  )

  // The dialog must not outlive its content (e.g. after a restart).
  $effect(() => {
    if (showPending && pendingPlugins.length === 0) showPending = false
  })

  const menuItems = $derived<MenuItem[]>([
    {
      label:
        plugins.remotePending === 'checking'
          ? 'Checking…'
          : 'Check for updates',
      detail: activeUpdates.length > 0 ? String(activeUpdates.length) : undefined,
      disabled: Boolean(plugins.remotePending),
      onSelect: () => {
        showUpdates = true
        void plugins.checkUpdates()
      },
    },
    {
      label: 'Install from URL…',
      disabled: Boolean(plugins.remotePending),
      onSelect: () => (showRemote = true),
    },
    {
      label:
        plugins.pending?.action === 'installFromDirectory'
          ? 'Installing…'
          : 'Install from folder…',
      disabled: Boolean(plugins.pending),
      onSelect: () => void plugins.installFromDirectory(),
    },
  ])

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
  }

  function closeGrant(): void {
    if (plugins.pending) return
    grantTargetId = undefined
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

  function progressPercent(): number | undefined {
    const progress = plugins.progress
    if (!progress?.totalBytes || progress.receivedBytes === undefined) {
      return undefined
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

  /** State -> semantic badge tone (failed/dropped are errors, degraded warns). */
  function stateTone(state: string): BadgeTone {
    switch (state) {
      case 'Active':
        return 'success'
      case 'Failed':
      case 'Dropped':
        return 'error'
      case 'Degraded':
        return 'warning'
      default:
        return 'neutral'
    }
  }

  onMount(() => {
    void plugins.load()
    void plugins.loadMarket()
    const offProgress = plugins.subscribeProgress()
    // Coalesce: a plugin-service restart emits one event per plugin, and the
    // action handler already reloads afterwards.
    let reloadTimer: ReturnType<typeof setTimeout> | undefined
    const off = ipc.subscribe(events.pluginStateChanged, () => {
      if (reloadTimer !== undefined) return
      reloadTimer = setTimeout(() => {
        reloadTimer = undefined
        void plugins.load()
        void plugins.loadMarket()
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

  /** Only declared capabilities can be granted; others are not part of the consent. */
  function deniedCapabilities(plugin: PluginDetailDto): string[] {
    return plugin.requires.filter(capability =>
      plugin.permissions.denied.includes(capability),
    )
  }

  /**
   * Uninstalled entries stay listed: remote records reinstall from their
   * recorded release, while directory installs have no replayable source and
   * fall back to the folder chooser.
   */
  function installRemoved(plugin: PluginDetailDto): void {
    if (plugin.origin?.kind === 'remote') {
      void plugins.reinstall(plugin.id)
      return
    }
    void plugins.installFromDirectory()
  }

  /**
   * Installs approve capabilities up front. This consent dialog remains a
   * fallback for plugins that are already installed but still denied (for
   * example a plugin installed before install-time approval existed).
   */
  function requestEnable(plugin: PluginDetailDto): void {
    const denied = deniedCapabilities(plugin)
    if (!plugin.builtin && denied.length > 0) {
      grantTargetId = plugin.id
      return
    }
    void plugins.enable(plugin.id)
  }

  function confirmGrantAndEnable(): void {
    const plugin = grantTarget
    if (!plugin) return
    const denied = deniedCapabilities(plugin)
    grantTargetId = undefined
    if (denied.length === 0) {
      void plugins.enable(plugin.id)
      return
    }
    void plugins.grantAndEnable(plugin.id, denied)
  }

  function enableLabel(plugin: PluginDetailDto): string {
    if (plugin.state === 'Failed' || plugin.state === 'Dropped') return 'Retry'
    return 'Enable'
  }

  function marketBadge(entry: PluginMarketEntryDto): {
    label: string
    tone: BadgeTone
  } {
    switch (entry.action) {
      case 'update':
        return { label: 'Update', tone: 'brand' }
      case 'installed':
        return { label: 'Installed', tone: 'success' }
      case 'incompatible':
        return { label: 'Incompatible', tone: 'warning' }
      default:
        return { label: 'Marketplace', tone: 'neutral' }
    }
  }

  function marketPendingFor(
    pluginId: string,
    action: 'install' | 'update',
  ): boolean {
    return (
      plugins.marketPending === action && plugins.marketPendingId === pluginId
    )
  }

  function installMarket(entry: PluginMarketEntryDto): void {
    if (marketBusy) return
    void plugins.installFromMarket(entry)
  }

  function updateMarket(entry: PluginMarketEntryDto): void {
    if (marketBusy) return
    void plugins.updateFromMarket(entry)
  }
</script>

<!--
  Two independent scroll areas: the list column and the detail card each own
  their scrollbar. Above 760px the section itself never scrolls; below it the
  panes stack and the section becomes the single scroller.
-->
<section class="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 min-[760px]:overflow-hidden">
  <!-- Same shape as before the redesign: search + list left, details right; it only
       stacks below 760px, matching the old media query. -->
  <div
    class="grid min-h-0 flex-1 grid-cols-[minmax(13.75rem,18.75rem)_1fr] grid-rows-[minmax(0,1fr)] gap-4 max-[760px]:grid-cols-1 max-[760px]:grid-rows-[auto_auto]"
  >
    <aside class="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
      <header class="flex items-center justify-between gap-2">
        <h2 class="text-base font-semibold">Plugins</h2>
        <div class="flex items-center gap-1">
          <IconButton
            label={plugins.loading ? 'Refreshing…' : 'Refresh'}
            disabled={plugins.loading}
            onclick={() => void plugins.load()}
          >
            <svg
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M13.4 8a5.4 5.4 0 1 1-1.6-3.8" />
              <path d="M13.4 2.6v3h-3" />
            </svg>
          </IconButton>
          <Menu items={menuItems} triggerLabel="More actions">
            {#snippet trigger()}
              <svg
                viewBox="0 0 16 16"
                width="16"
                height="16"
                fill="currentColor"
                aria-hidden="true"
              >
                <circle cx="3.2" cy="8" r="1.25" />
                <circle cx="8" cy="8" r="1.25" />
                <circle cx="12.8" cy="8" r="1.25" />
              </svg>
              {#if activeUpdates.length > 0}
                <span
                  class="absolute right-1 top-1 size-1.5 rounded-full bg-brand-light dark:bg-brand-dark"
                  aria-hidden="true"
                ></span>
              {/if}
            {/snippet}
          </Menu>
        </div>
      </header>

      <TextField
        bind:value={query}
        placeholder="Search installed and marketplace plugins"
        aria-label="Search installed and marketplace plugins"
        autocomplete="off"
        spellcheck="false"
      />

      {#if plugins.loadError}
        <Alert tone="error">
          <span class="flex items-center justify-between gap-2">
            <span>{plugins.loadError}</span>
            <Button variant="link" size="sm" onclick={() => void plugins.load()}>
              Retry
            </Button>
          </span>
        </Alert>
      {/if}
      {#if plugins.actionError}
        <Alert tone="error">{plugins.actionError}</Alert>
      {/if}
      {#if plugins.notice}
        <Alert tone="info">{plugins.notice}</Alert>
      {/if}
      {#if plugins.restartRequired}
        <Alert tone="warning">
          <span>
            Restart the plugin service to apply
            <button
              type="button"
              class="text-primary-500 underline underline-offset-2 hover:text-primary-400"
              onclick={() => (showPending = true)}
            >
              pending changes
            </button>.
          </span>
          {#snippet actions()}
            <Button
              size="sm"
              variant="secondary"
              loading={plugins.pending?.action === 'restart'}
              loadingLabel="Restarting…"
              disabled={Boolean(plugins.pending)}
              onclick={() => void plugins.restart()}
            >
              Restart plugins
            </Button>
          {/snippet}
        </Alert>
      {/if}

      {#if plugins.issues.length > 0}
        <details class="text-xs text-surface-600-400">
          <summary>{plugins.issues.length} discovery or validation issue(s)</summary>
          {#each plugins.issues as issue}
            <p class="mt-1">{issue}</p>
          {/each}
        </details>
      {/if}

      {#if plugins.loading && plugins.items.length === 0 && !plugins.loadError}
        <p class="text-sm text-surface-600-400">Loading plugins…</p>
      {/if}

      <section class="flex flex-col gap-2" aria-label="Installed plugins">
        <header class="flex items-center justify-between">
          <h3
            class="text-[11px] font-semibold uppercase tracking-wider text-surface-600-400"
          >
            Installed
          </h3>
          <span class="text-[11px] text-surface-600-400">
            {plugins.items.length}
          </span>
        </header>
        {#if plugins.items.length === 0}
          {#if !searchActive && !plugins.loading}
            <div class="flex flex-col items-start gap-1">
              <p class="text-xs text-surface-600-400">No plugins installed.</p>
              <Button
                variant="link"
                size="sm"
                loading={plugins.pending?.action === 'installFromDirectory'}
                loadingLabel="Installing…"
                disabled={Boolean(plugins.pending)}
                onclick={() => void plugins.installFromDirectory()}
              >
                Install from folder…
              </Button>
            </div>
          {/if}
        {:else}
          <div class="flex flex-col gap-1">
            {#each filteredPlugins as plugin (plugin.id)}
              {@const market = marketById.get(plugin.id)}
              <!--
                The card surface IS the interactive element: the whole row is the
                target, and Skeleton's `card` utility already supplies the button
                hover treatment. Nesting a button inside a Card would shrink the
                click area to the content and add a second interactive element.
              -->
              <button
                type="button"
                class={cn(
                  'card flex flex-col items-stretch gap-1 border px-3 py-2 text-left transition-colors',
                  plugin.id === plugins.selectedId
                    ? 'border-brand-light bg-surface-50-950 dark:border-brand-dark'
                    : 'border-surface-200-800 bg-surface-100-900 hover:preset-tonal',
                )}
                onclick={() => plugins.select(plugin.id)}
              >
                <span class="flex items-start justify-between gap-2">
                  <span class="min-w-0 flex-1 truncate text-sm font-semibold"
                    >{plugin.name}</span
                  >
                  <span class="flex shrink-0 items-center gap-1">
                    {#if market?.updateAvailable}
                      <Badge tone="brand">Update</Badge>
                    {/if}
                    <Badge tone={stateTone(plugin.state)}>{plugin.state}</Badge>
                  </span>
                </span>
                {#if plugin.author}
                  <span class="truncate text-[11px] text-surface-600-400">
                    {plugin.author}
                  </span>
                {/if}
                {#if plugin.description}
                  <span
                    class="line-clamp-2 text-xs leading-snug text-surface-600-400"
                  >
                    {plugin.description}
                  </span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      </section>

      <section class="flex flex-col gap-2" aria-label="Official marketplace">
        <header class="flex items-center justify-between">
          <h3
            class="text-[11px] font-semibold uppercase tracking-wider text-surface-600-400"
          >
            Marketplace
          </h3>
          <IconButton
            size="sm"
            label={
              plugins.marketLoading
                ? 'Refreshing marketplace…'
                : 'Refresh marketplace'
            }
            disabled={plugins.marketLoading}
            onclick={() => void plugins.loadMarket(true)}
          >
            <svg
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M13.4 8a5.4 5.4 0 1 1-1.6-3.8" />
              <path d="M13.4 2.6v3h-3" />
            </svg>
          </IconButton>
        </header>

        {#if plugins.marketLoading}
          <p class="text-xs text-surface-600-400">Loading marketplace…</p>
        {/if}
        {#if plugins.marketLoadError}
          <Alert tone="error">
            {plugins.marketLoadError}
            {#snippet actions()}
              <Button
                size="sm"
                variant="secondary"
                disabled={plugins.marketLoading}
                onclick={() => void plugins.loadMarket(true)}
              >
                Retry
              </Button>
            {/snippet}
          </Alert>
        {/if}
        {#if plugins.marketStale}
          <Alert tone="warning">
            Showing the last cached marketplace index
            {#if plugins.marketFetchedAt}
              from {plugins.marketFetchedAt}
            {/if}. Install and update still require a live registry check.
          </Alert>
        {/if}
        {#if plugins.marketWarnings.length > 0}
          <details class="text-xs text-surface-600-400">
            <summary>
              {plugins.marketWarnings.length} marketplace warning(s)
            </summary>
            {#each plugins.marketWarnings as warning, index (index)}
              <p class="mt-1">{warning}</p>
            {/each}
          </details>
        {/if}

        {#if filteredMarket.length > 0}
          <div class="flex flex-col gap-1">
            {#each filteredMarket as entry (entry.id)}
              {@const badge = marketBadge(entry)}
              <button
                type="button"
                class={cn(
                  'card flex flex-col items-stretch gap-1 border px-3 py-2 text-left transition-colors',
                  entry.id === plugins.selectedId
                    ? 'border-brand-light bg-surface-50-950 dark:border-brand-dark'
                    : 'border-surface-200-800 bg-surface-100-900 hover:preset-tonal',
                )}
                onclick={() => plugins.select(entry.id)}
              >
                <span class="flex items-start justify-between gap-2">
                  <span class="min-w-0 flex-1 truncate text-sm font-semibold"
                    >{entry.name}</span
                  >
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                </span>
                <span class="truncate text-[11px] text-surface-600-400">
                  {entry.author}
                </span>
                <span
                  class="line-clamp-2 text-xs leading-snug text-surface-600-400"
                >
                  {entry.description}
                </span>
              </button>
            {/each}
          </div>
        {:else if !searchActive && !plugins.marketLoading && !plugins.marketLoadError}
          <p class="text-xs text-surface-600-400">
            No marketplace plugins available.
          </p>
        {/if}
      </section>

      {#if noSearchResults}
        <EmptyState
          title="No plugins match your search."
          description="Try a different name, plugin id, description or tag."
        />
      {/if}
    </aside>

    {#if plugins.selected}
      {@const selected = plugins.selected}
      {@const market = marketById.get(selected.id)}
      <Card class="flex min-h-0 flex-col gap-4 overflow-y-auto">
        <header class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <h3 class="text-base font-semibold">{selected.name}</h3>
            <code class="break-all font-mono text-xs text-surface-600-400"
              >{selected.id}</code
            >
          </div>
          <Badge tone={stateTone(selected.state)}>{selected.state}</Badge>
        </header>

        {#if selected.description}
          <p class="text-sm">{selected.description}</p>
        {/if}
        {#if selected.error}
          <Alert tone="error">{selected.error}</Alert>
        {/if}
        {#if plugins.marketError}
          <Alert tone="error">{plugins.marketError}</Alert>
        {/if}
        {#if selected.state === 'NotInstalled'}
          <Alert tone="warning">
            This plugin is uninstalled. Its saved configuration and data are
            preserved; install it again to restore it.
          </Alert>
        {/if}

        <dl class="grid grid-cols-[6.5rem_1fr] gap-x-4 gap-y-1 text-xs">
          <dt class="text-surface-600-400">Version</dt>
          <dd>{selected.version}</dd>
          <dt class="text-surface-600-400">Source</dt>
          <dd>{selected.source}</dd>
          {#if selected.origin}
            <dt class="text-surface-600-400">Origin</dt>
            <dd>
              {#if selected.origin.kind === 'remote'}
                <code class="break-all font-mono">{selected.origin.url}</code>
                {#if selected.origin.sha256}
                  <p class="text-surface-600-400">
                    sha256 {selected.origin.sha256.slice(0, 12)}…
                  </p>
                {/if}
              {:else}
                Local directory
              {/if}
            </dd>
          {/if}
          <dt class="text-surface-600-400">Entry</dt>
          <dd><code class="font-mono">{selected.entry}</code></dd>
          <dt class="text-surface-600-400">Kernel</dt>
          <dd>{selected.compatibility.minKernel}</dd>
          <dt class="text-surface-600-400">Contract</dt>
          <dd>{selected.compatibility.contractVersion}</dd>
          {#if selected.author}
            <dt class="text-surface-600-400">Author</dt>
            <dd>{selected.author}</dd>
          {/if}
        </dl>

        {#if market}
          <section
            class="flex flex-col gap-2 rounded-base border border-surface-200-800 p-3"
          >
            <h4
              class="text-xs font-semibold uppercase tracking-wider text-surface-600-400"
            >
              Marketplace
            </h4>
            <dl class="grid grid-cols-[6.5rem_1fr] gap-x-4 gap-y-1 text-xs">
              <dt class="text-surface-600-400">Latest version</dt>
              <dd>{market.version}</dd>
              <dt class="text-surface-600-400">Repository</dt>
              <dd>
                <code class="break-all font-mono">{market.repository}</code>
              </dd>
              <dt class="text-surface-600-400">Kernel</dt>
              <dd>{market.compatibility.minKernel}</dd>
              <dt class="text-surface-600-400">Contract</dt>
              <dd>{market.compatibility.contractVersion}</dd>
            </dl>
            {#if !market.compatibility.compatible}
              <Alert tone="warning">
                This kernel cannot run the latest marketplace version:
                {#each market.compatibility.reasons as reason, index (index)}
                  <p>{reason}</p>
                {:else}
                  <p>The compatibility contract is not satisfied.</p>
                {/each}
              </Alert>
            {:else if market.updateAvailable}
              <p class="text-xs">
                Update available: <strong>{selected.version}</strong> →
                <strong>{market.version}</strong>
              </p>
            {:else}
              <p class="text-xs text-surface-600-400">
                {selected.state === 'NotInstalled'
                  ? 'Available in the marketplace.'
                  : 'No newer marketplace version is available.'}
              </p>
            {/if}
          </section>
        {/if}

        <div class="grid grid-cols-2 gap-4 max-[760px]:grid-cols-1">
          <section>
            <h4
              class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-600-400"
            >
              Dependencies
            </h4>
            {#each Object.entries(selected.dependencies) as [id, range]}
              <p class="text-xs"><code class="font-mono">{id}</code> <span>{range}</span></p>
            {:else}
              <p class="text-xs text-surface-600-400">None</p>
            {/each}
          </section>
          <section>
            <h4
              class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-600-400"
            >
              Required capabilities
            </h4>
            {#each selected.requires as capability}
              <p class="mb-1 flex items-center gap-2 text-xs">
                <code class="font-mono">{capability}</code>
                {#if !selected.builtin}
                  <Badge
                    tone={selected.permissions.denied.includes(capability)
                      ? 'warning'
                      : 'success'}
                  >
                    {selected.permissions.denied.includes(capability)
                      ? 'denied'
                      : 'granted'}
                  </Badge>
                {/if}
              </p>
            {:else}
              <p class="text-xs text-surface-600-400">None</p>
            {/each}
            {#if !selected.builtin && selected.permissions.denied.length > 0}
              <p class="mt-2 text-xs text-surface-600-400">
                Capabilities are never granted automatically. Enabling this
                plugin asks for the remaining denied capabilities.
              </p>
            {/if}
          </section>
        </div>

        {#if market && marketPendingFor(selected.id, 'update')}
          <div class="flex flex-col items-start gap-2">
            <Progress
              class="w-full"
              value={progressPercent()}
              label={phaseLabel()}
              detail={progressLabel()}
            />
            {#if plugins.progress?.phase !== 'installing'}
              <Button
                size="sm"
                variant="secondary"
                loading={plugins.cancelling}
                loadingLabel="Cancelling…"
                onclick={() => void plugins.cancelDownload()}
              >
                Cancel download
              </Button>
            {/if}
          </div>
        {/if}

        <div class="flex flex-wrap items-center gap-2 border-t border-surface-200-800 pt-4">
          {#if market && market.updateAvailable}
            <Button
              loading={marketPendingFor(selected.id, 'update')}
              loadingLabel="Updating…"
              disabled={marketBusy}
              onclick={() => updateMarket(market)}
            >
              Update to {market.version}
            </Button>
          {/if}
          {#if selected.state === 'NotInstalled'}
            {#if market}
              <Button
                loading={marketPendingFor(selected.id, 'install')}
                loadingLabel="Installing…"
                disabled={!market.compatibility.compatible || marketBusy}
                onclick={() => installMarket(market)}
              >
                {market.compatibility.compatible ? 'Install' : 'Incompatible'}
              </Button>
            {:else}
              <Button
                loading={plugins.pending?.action === 'reinstall' && plugins.pending.pluginId === selected.id}
                loadingLabel="Installing…"
                disabled={marketBusy}
                onclick={() => installRemoved(selected)}
              >
                Install
              </Button>
            {/if}
          {:else if canDisable(selected)}
            <Button
              variant="secondary"
              loading={plugins.pending?.action === 'disable' && plugins.pending.pluginId === selected.id}
              loadingLabel="Disabling…"
              disabled={marketBusy}
              onclick={() => void plugins.disable(selected.id)}
            >
              Disable
            </Button>
          {:else}
            <Button
              loading={plugins.pending?.action === 'enable' && plugins.pending.pluginId === selected.id}
              loadingLabel="Enabling…"
              disabled={marketBusy}
              onclick={() => requestEnable(selected)}
            >
              {enableLabel(selected)}
            </Button>
          {/if}
          {#if selected.canUninstall}
            <Button
              variant="danger"
              loading={plugins.pending?.action === 'uninstall' && plugins.pending.pluginId === selected.id}
              loadingLabel="Uninstalling…"
              disabled={marketBusy}
              onclick={() => void plugins.uninstall(selected.id)}
            >
              Uninstall
            </Button>
          {/if}
        </div>
      </Card>
    {:else if selectedMarket}
      <PluginMarketDetail
        entry={selectedMarket}
        progress={marketPendingFor(selectedMarket.id, 'install')
          ? plugins.progress
          : undefined}
        pending={marketPendingFor(selectedMarket.id, 'install')}
        cancelling={plugins.cancelling}
        error={plugins.marketError}
        oninstall={() => installMarket(selectedMarket)}
        oncancel={() => void plugins.cancelDownload()}
      />
    {:else}
      <Card class="flex min-h-0 flex-col gap-4 overflow-y-auto">
        <EmptyState
          title="Select a plugin to view details."
          description="Select an installed plugin or a marketplace entry from the list."
        />
      </Card>
    {/if}
  </div>

  <Dialog
    bind:open={showPending}
    title="Pending changes"
    description="These plugins are disabled on disk but still running. Restart the plugin service to stop them."
  >
    <ul class="flex list-none flex-col gap-1 p-0">
      {#each pendingPlugins as plugin (plugin.id)}
        <li
          class="flex items-center gap-3 border-b border-surface-200-800 py-1 text-xs last:border-b-0"
        >
          <span class="flex-1 font-semibold">{plugin.name}</span>
          <code class="font-mono text-surface-600-400">{plugin.id}</code>
          <Badge tone={stateTone(plugin.state)}>{plugin.state}</Badge>
        </li>
      {/each}
    </ul>
    {#snippet footer()}
      <Button variant="secondary" onclick={closePending}>Close</Button>
      <Button
        loading={plugins.pending?.action === 'restart'}
        loadingLabel="Restarting…"
        disabled={Boolean(plugins.pending)}
        onclick={() => void plugins.restart()}
      >
        Restart plugins
      </Button>
    {/snippet}
  </Dialog>

  <Dialog
    bind:open={showRemote}
    size="lg"
    closeable={!plugins.remotePending}
    title="Install from URL"
    description="Only HTTPS release URLs on the allowlist (GitHub) are accepted. The package is downloaded and inspected first; approving the capabilities installs and enables the plugin in one step."
  >
    <Field label="Release URL" forId="remote-url">
      <TextField
        id="remote-url"
        bind:value={remoteUrl}
        placeholder="https://github.com/owner/repo/releases/tag/v1.0.0"
        disabled={Boolean(plugins.remotePending)}
        autocomplete="off"
        spellcheck="false"
      />
    </Field>

    {#if remoteBusy || plugins.cancelling}
      <div class="flex flex-col items-start gap-2">
        <Progress
          class="w-full"
          value={progressPercent()}
          label={phaseLabel()}
          detail={progressLabel()}
        />
        {#if plugins.remotePending !== 'updating' && plugins.progress?.phase !== 'installing'}
          <Button
            size="sm"
            variant="secondary"
            loading={plugins.cancelling}
            loadingLabel="Cancelling…"
            onclick={() => void plugins.cancelDownload()}
          >
            Cancel download
          </Button>
        {/if}
      </div>
    {/if}

    {#if plugins.remoteError}
      <Alert tone="error">{plugins.remoteError}</Alert>
    {/if}

    {#if plugins.inspection}
      {@const inspection = plugins.inspection}
      <section class="flex flex-col gap-3 border-t border-surface-200-800 pt-4">
        <h4 class="text-sm font-semibold">Package preview</h4>
        <dl class="grid grid-cols-[6.5rem_1fr] gap-x-4 gap-y-1 text-xs">
          <dt class="text-surface-600-400">Source</dt>
          <dd><code class="break-all font-mono">{inspection.url}</code></dd>
          <dt class="text-surface-600-400">Asset</dt>
          <dd><code class="break-all font-mono">{inspection.downloadUrl}</code></dd>
          <dt class="text-surface-600-400">Id</dt>
          <dd><code class="font-mono">{inspection.id}</code></dd>
          <dt class="text-surface-600-400">Name</dt>
          <dd>{inspection.name}</dd>
          <dt class="text-surface-600-400">Version</dt>
          <dd>{inspection.version}</dd>
          {#if inspection.publishedAt}
            <dt class="text-surface-600-400">Published</dt>
            <dd>{inspection.publishedAt}</dd>
          {/if}
          {#if inspection.size !== undefined}
            <dt class="text-surface-600-400">Size</dt>
            <dd>{formatBytes(inspection.size)}</dd>
          {/if}
          <dt class="text-surface-600-400">SHA-256</dt>
          <dd>
            {#if inspection.sha256}
              <code class="break-all font-mono text-[11px]">{inspection.sha256}</code>
              <span class="block text-xs text-success-600-400">from release metadata</span>
            {:else}
              <span class="text-xs text-warning-600-400">Not published</span>
            {/if}
          </dd>
        </dl>
        {#if inspection.notes}
          <p class="text-xs text-surface-600-400">{notesSummary(inspection.notes)}</p>
        {/if}
        <div class="grid grid-cols-2 gap-4 max-[760px]:grid-cols-1">
          <section>
            <h4
              class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-600-400"
            >
              Capabilities approved on install
            </h4>
            {#each inspection.requires as capability}
              <p class="text-xs"><code class="font-mono">{capability}</code></p>
            {:else}
              <p class="text-xs text-surface-600-400">None</p>
            {/each}
          </section>
          <section>
            <h4
              class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-600-400"
            >
              Dependencies
            </h4>
            {#each Object.entries(inspection.dependencies) as [id, range]}
              <p class="text-xs"><code class="font-mono">{id}</code> <span>{range}</span></p>
            {:else}
              <p class="text-xs text-surface-600-400">None</p>
            {/each}
          </section>
        </div>
        <p class="text-xs text-warning-600-400">
          Declared capabilities are permissions, not a sandbox. Approving them
          grants exactly these capabilities and enables the plugin right after
          installation. SHA-256 only proves integrity, not who published the
          package: there is no signature verification.
        </p>
        {#if !inspection.sha256}
          <Alert tone="error">
            The publisher did not provide a SHA-256 digest, so installation is
            blocked.
          </Alert>
        {/if}
        <div class="flex justify-end">
          <Button
            loading={plugins.remotePending === 'installing'}
            loadingLabel="Installing…"
            disabled={!inspection.sha256 || Boolean(plugins.remotePending)}
            onclick={() => void plugins.installRemote()}
          >
            {inspection.requires.length > 0
              ? 'Approve capabilities & install'
              : 'Install & enable'}
          </Button>
        </div>
      </section>
    {/if}

    {#snippet footer()}
      <Button
        variant="secondary"
        disabled={Boolean(plugins.remotePending)}
        onclick={closeRemote}
      >
        Close
      </Button>
      <Button
        loading={plugins.remotePending === 'inspecting'}
        loadingLabel="Inspecting…"
        disabled={!remoteUrl.trim() || Boolean(plugins.remotePending)}
        onclick={() => void plugins.inspectRemote(remoteUrl.trim())}
      >
        Inspect
      </Button>
    {/snippet}
  </Dialog>

  <Dialog
    bind:open={showUpdates}
    size="lg"
    closeable={!plugins.remotePending}
    title="Plugin updates"
    description="Installed remote plugins are compared with their recorded release source. Nothing installs until you confirm a specific version."
  >
    {#if plugins.updateError}
      <Alert tone="error">{plugins.updateError}</Alert>
    {/if}
    {#if plugins.remotePending === 'checking'}
      <p class="text-sm text-surface-600-400">Checking…</p>
    {:else if activeUpdates.length === 0}
      <p class="text-sm text-surface-600-400">
        {plugins.updateError
          ? 'No applicable updates found; resolve the source issues above and check again.'
          : 'No updates available.'}
      </p>
    {:else}
      <ul class="flex list-none flex-col gap-2 p-0">
        {#each activeUpdates as update (update.pluginId)}
          <li
            class="flex items-start justify-between gap-3 rounded-base border border-surface-200-800 p-3"
          >
            <div class="min-w-0">
              <strong class="text-sm">
                {plugins.items.find((item) => item.id === update.pluginId)
                  ?.name ?? update.pluginId}
              </strong>
              <code class="ml-2 font-mono text-xs text-surface-600-400"
                >{update.pluginId}</code
              >
              <p class="mt-1 font-mono text-xs text-primary-500">
                {update.currentVersion} → {update.latestVersion}
              </p>
              {#if update.publishedAt}
                <p class="text-xs text-surface-600-400">
                  Published {update.publishedAt}
                </p>
              {/if}
              {#if update.notes}
                <p class="text-xs text-surface-600-400">
                  {notesSummary(update.notes)}
                </p>
              {/if}
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={Boolean(plugins.remotePending)}
              onclick={() => (updateTarget = update.pluginId)}
            >
              Update
            </Button>
          </li>
        {/each}
      </ul>
    {/if}

    {#snippet footer()}
      <Button
        variant="secondary"
        disabled={Boolean(plugins.remotePending)}
        onclick={closeUpdates}
      >
        Close
      </Button>
      <Button
        loading={plugins.remotePending === 'checking'}
        loadingLabel="Checking…"
        disabled={Boolean(plugins.remotePending)}
        onclick={() => void plugins.checkUpdates()}
      >
        Re-check
      </Button>
    {/snippet}
  </Dialog>

  {#if updateTargetEntry}
    {@const entry = updateTargetEntry}
    <Dialog
      open={true}
      title="Update plugin"
      onOpenChange={(next) => {
        if (!next) updateTarget = undefined
      }}
    >
      <p class="text-sm">
        Update
        <strong>{updateTargetPlugin?.name ?? entry.pluginId}</strong>
        from <code class="font-mono">{entry.currentVersion}</code> to
        <code class="font-mono">{entry.latestVersion}</code>?
      </p>
      <dl class="grid grid-cols-[6.5rem_1fr] gap-x-4 gap-y-1 text-xs">
        <dt class="text-surface-600-400">Source</dt>
        <dd><code class="break-all font-mono">{entry.url}</code></dd>
        <dt class="text-surface-600-400">SHA-256</dt>
        <dd>
          {#if entry.sha256}
            <code class="break-all font-mono text-[11px]">{entry.sha256}</code>
          {:else}
            <span class="text-xs text-warning-600-400">
              Not published — update blocked
            </span>
          {/if}
        </dd>
        <dt class="text-surface-600-400">Capabilities</dt>
        <dd class="flex flex-wrap gap-1">
          {#each updateTargetPlugin?.requires ?? [] as capability}
            <code class="font-mono">{capability}</code>
          {:else}
            <span class="text-surface-600-400">None declared</span>
          {/each}
        </dd>
      </dl>
      {#if remoteBusy || plugins.cancelling}
        <Progress
          value={progressPercent()}
          label={phaseLabel()}
          detail={progressLabel()}
        />
      {/if}
      <p class="text-xs text-warning-600-400">
        Capabilities shown belong to the installed version. If the new package
        declares additional capabilities, it is installed disabled and you must
        approve them before it can run. The old version is backed up and
        restored automatically if the update fails. SHA-256 proves integrity
        only; it does not prove who published this package.
      </p>
      {#snippet footer()}
        <Button
          variant="secondary"
          disabled={Boolean(plugins.remotePending)}
          onclick={() => (updateTarget = undefined)}
        >
          Cancel
        </Button>
        <Button
          loading={plugins.remotePending === 'updating'}
          loadingLabel="Updating…"
          disabled={!entry.sha256 || Boolean(plugins.remotePending)}
          onclick={() => {
            const update = entry
            updateTarget = undefined
            void plugins.applyUpdate(update)
          }}
        >
          Confirm update
        </Button>
      {/snippet}
    </Dialog>
  {/if}

  {#if grantTarget}
    {@const target = grantTarget}
    <Dialog
      open={true}
      closeable={!plugins.pending}
      title="Approve plugin capabilities"
      onOpenChange={(next) => {
        if (!next) closeGrant()
      }}
    >
      <p class="text-sm">
        <strong>{target.name}</strong> is user-installed and runs inside the
        sandbox. Enabling it requires these declared capabilities:
      </p>
      <ul class="flex list-none flex-col gap-1 p-0">
        {#each target.requires as capability}
          <li
            class="flex items-center justify-between gap-3 border-b border-surface-200-800 py-1 text-xs last:border-b-0"
          >
            <code class="font-mono">{capability}</code>
            <Badge
              tone={target.permissions.denied.includes(capability)
                ? 'warning'
                : 'success'}
            >
              {target.permissions.denied.includes(capability)
                ? 'denied'
                : 'granted'}
            </Badge>
          </li>
        {:else}
          <li class="text-xs text-surface-600-400">None declared</li>
        {/each}
      </ul>
      <p class="text-xs text-warning-600-400">
        Approving grants only these declared capabilities to this plugin. They
        apply when the plugin starts; this flow enables it immediately. Other
        plugins remain sandboxed, and a grant never exceeds the manifest.
      </p>
      {#snippet footer()}
        <Button
          variant="secondary"
          disabled={Boolean(plugins.pending)}
          onclick={closeGrant}
        >
          Cancel
        </Button>
        <Button
          loading={Boolean(plugins.pending)}
          loadingLabel="Enabling…"
          disabled={Boolean(plugins.pending) || grantDenied.length === 0}
          onclick={confirmGrantAndEnable}
        >
          Agree and enable
        </Button>
      {/snippet}
    </Dialog>
  {/if}
</section>
