<script lang="ts">
  import type {
    PluginDownloadProgressDto,
    PluginMarketEntryDto,
  } from '@/shared/ipc-contract'
  import Alert from '@/frontend/lib/ui/Alert.svelte'
  import Badge from '@/frontend/lib/ui/Badge.svelte'
  import Button from '@/frontend/lib/ui/Button.svelte'
  import Card from '@/frontend/lib/ui/Card.svelte'
  import Progress from '@/frontend/lib/ui/Progress.svelte'

  let {
    entry,
    progress,
    pending = false,
    cancelling = false,
    error,
    oninstall,
    oncancel,
  }: {
    entry: PluginMarketEntryDto
    progress?: PluginDownloadProgressDto
    pending?: boolean
    cancelling?: boolean
    error?: string
    oninstall: () => void
    oncancel?: () => void
  } = $props()

  function formatBytes(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0 B'
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`
    return `${value} B`
  }

  function progressLabel(): string {
    switch (progress?.phase) {
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

  function progressDetail(): string {
    const received = progress?.receivedBytes
    const total = progress?.totalBytes
    if (received !== undefined && total !== undefined && total > 0) {
      return `${formatBytes(received)} / ${formatBytes(total)}`
    }
    return received !== undefined ? formatBytes(received) : ''
  }

  const progressPercent = $derived(
    progress?.totalBytes && progress.receivedBytes !== undefined
      ? Math.min(
          100,
          Math.round((progress.receivedBytes / progress.totalBytes) * 100),
        )
      : undefined,
  )
</script>

<Card class="flex min-h-0 flex-col gap-4 overflow-y-auto">
  <header class="flex items-start justify-between gap-4">
    <div class="min-w-0">
      <h3 class="text-base font-semibold">{entry.name}</h3>
      <code class="break-all font-mono text-xs text-surface-600-400">
        {entry.id}
      </code>
    </div>
    <Badge tone={entry.compatibility.compatible ? 'brand' : 'warning'}>
      {entry.compatibility.compatible ? 'Marketplace' : 'Incompatible'}
    </Badge>
  </header>

  <p class="text-sm">{entry.description}</p>

  {#if error}
    <Alert tone="error">{error}</Alert>
  {/if}

  {#if !entry.compatibility.compatible}
    <Alert tone="warning" title="This version cannot run on this kernel">
      {#each entry.compatibility.reasons as reason, index (index)}
        <p>{reason}</p>
      {:else}
        <p>The plugin does not satisfy this kernel's compatibility contract.</p>
      {/each}
    </Alert>
  {/if}

  <dl class="grid grid-cols-[6.5rem_1fr] gap-x-4 gap-y-1 text-xs">
    <dt class="text-surface-600-400">Version</dt>
    <dd>{entry.version}</dd>
    <dt class="text-surface-600-400">Author</dt>
    <dd>{entry.author}</dd>
    <dt class="text-surface-600-400">Kernel</dt>
    <dd>
      {entry.compatibility.minKernel}
      {#if entry.compatibility.maxKernel}
        &lt; {entry.compatibility.maxKernel}
      {/if}
    </dd>
    <dt class="text-surface-600-400">Contract</dt>
    <dd>{entry.compatibility.contractVersion}</dd>
    <dt class="text-surface-600-400">Repository</dt>
    <dd><code class="break-all font-mono">{entry.repository}</code></dd>
    {#if entry.homepage}
      <dt class="text-surface-600-400">Homepage</dt>
      <dd><code class="break-all font-mono">{entry.homepage}</code></dd>
    {/if}
    {#if entry.publishedAt}
      <dt class="text-surface-600-400">Published</dt>
      <dd>{entry.publishedAt}</dd>
    {/if}
    <dt class="text-surface-600-400">Size</dt>
    <dd>{formatBytes(entry.sizeBytes)}</dd>
  </dl>

  {#if entry.tags.length > 0}
    <section>
      <h4
        class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-600-400"
      >
        Tags
      </h4>
      <div class="flex flex-wrap gap-1">
        {#each entry.tags as tag (tag)}
          <Badge tone="neutral">{tag}</Badge>
        {/each}
      </div>
    </section>
  {/if}

  <section>
    <h4
      class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-600-400"
    >
      Required capabilities
    </h4>
    {#each entry.requires as capability (capability)}
      <p class="mb-1 flex items-center gap-2 text-xs">
        <code class="font-mono">{capability}</code>
        <Badge tone="warning">required</Badge>
      </p>
    {:else}
      <p class="text-xs text-surface-600-400">None declared</p>
    {/each}
    <p class="mt-2 text-xs text-surface-600-400">
      Installation does not grant these capabilities. After installing, review
      the permissions and enable the plugin explicitly.
    </p>
  </section>

  {#if pending || progress}
    <div class="flex flex-col items-start gap-2">
      <Progress
        class="w-full"
        value={progressPercent}
        label={progressLabel()}
        detail={progressDetail()}
      />
      {#if oncancel && progress?.phase !== 'installing'}
        <Button
          size="sm"
          variant="secondary"
          loading={cancelling}
          loadingLabel="Cancelling…"
          onclick={oncancel}
        >
          Cancel download
        </Button>
      {/if}
    </div>
  {/if}

  <div class="flex flex-wrap items-center gap-2 border-t border-surface-200-800 pt-4">
    <Button
      loading={pending}
      loadingLabel="Installing…"
      disabled={!entry.compatibility.compatible || pending || cancelling}
      onclick={oninstall}
    >
      Install
    </Button>
    <p class="text-xs text-surface-600-400">
      The package is verified against the registry and SHA-256 before install.
    </p>
  </div>
</Card>
