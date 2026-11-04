<script lang="ts">
  import { onMount } from 'svelte'
  import { appSettings } from '@/frontend/lib/stores/settings.svelte'
  import {
    LOG_LEVELS,
    type LogLevelDto,
    type ProxyModeDto,
    type ProxySettingsDto,
  } from '@/shared/ipc-contract'
  import Alert from '@/frontend/lib/ui/Alert.svelte'
  import Button from '@/frontend/lib/ui/Button.svelte'
  import Card from '@/frontend/lib/ui/Card.svelte'
  import Field from '@/frontend/lib/ui/Field.svelte'
  import Select from '@/frontend/lib/ui/Select.svelte'
  import TextField from '@/frontend/lib/ui/TextField.svelte'
  import ThemeToggle from './ThemeToggle.svelte'

  const modeOptions = [
    { value: 'system', label: 'Use system proxy (default)' },
    { value: 'manual', label: 'Manual proxy' },
    { value: 'direct', label: 'Direct connection (no proxy)' },
  ]

  const levelLabels: Record<LogLevelDto, string> = {
    trace: 'Trace',
    debug: 'Debug',
    info: 'Info',
    warn: 'Warning',
    error: 'Error',
    fatal: 'Fatal',
  }

  const logLevelOptions = LOG_LEVELS.map(level => ({
    value: level,
    label: levelLabels[level],
  }))

  let mode = $state<ProxyModeDto>('system')
  let address = $state('')
  let bypass = $state('')
  let loggingEnabled = $state(true)
  let logLevel = $state<LogLevelDto>('info')

  // The host is the source of truth: reload/save responses reset the form.
  $effect(() => {
    const proxy = appSettings.proxy
    mode = proxy.mode
    address = proxy.address ?? ''
    bypass = proxy.bypass ?? ''
  })

  $effect(() => {
    const logging = appSettings.logging
    loggingEnabled = logging.enabled
    logLevel = logging.level
  })

  const canSave = $derived(
    !appSettings.saving &&
      !appSettings.loading &&
      (mode !== 'manual' || address.trim().length > 0),
  )

  const loggingDirty = $derived(
    loggingEnabled !== appSettings.logging.enabled ||
      logLevel !== appSettings.logging.level,
  )

  onMount(() => {
    void appSettings.load()
    void appSettings.loadLogging()
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

<section class="min-h-0 flex-1 overflow-auto p-4">
  <div class="mx-auto flex max-w-xl flex-col gap-4">
    <header class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-lg font-semibold">Settings</h2>
        <p class="text-xs text-surface-600-400">
          Appearance and the network proxy used by Electron traffic and plugin
          downloads. Changes apply immediately.
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        loading={appSettings.loading}
        loadingLabel="Reloading…"
        disabled={appSettings.saving}
        onclick={() => void appSettings.load()}
      >
        Reload
      </Button>
    </header>

    {#if appSettings.error}
      <Alert tone="error">{appSettings.error}</Alert>
    {/if}
    {#if appSettings.notice}
      <Alert tone="info">{appSettings.notice}</Alert>
    {/if}

    <Card>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-col gap-1">
          <h3 class="text-sm font-semibold">Appearance</h3>
          <p class="text-xs text-surface-600-400">
            Light, dark, or follow the operating system. The choice is saved
            immediately.
          </p>
        </div>
        <ThemeToggle />
      </div>
    </Card>

    <Card>
      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-1">
          <h3 class="text-sm font-semibold">Console logging</h3>
          <p class="text-xs text-surface-600-400">
            Write kernel logs to the terminal. The level filters every log sink;
            turning this off only removes the console output.
          </p>
        </div>

        <label class="flex items-center gap-2 text-sm" for="logging-enabled">
          <input
            id="logging-enabled"
            type="checkbox"
            bind:checked={loggingEnabled}
            class="size-4 accent-primary-500"
            disabled={appSettings.loggingSaving}
          />
          Write kernel logs to the terminal
        </label>

        <Field label="Log level" forId="log-level">
          <Select
            id="log-level"
            bind:value={logLevel}
            options={logLevelOptions}
            disabled={appSettings.loggingSaving}
          />
        </Field>

        <div class="flex justify-end border-t border-surface-200-800 pt-4">
          <Button
            type="button"
            loading={appSettings.loggingSaving}
            loadingLabel="Applying…"
            disabled={!loggingDirty || appSettings.loggingSaving}
            onclick={() =>
              void appSettings.saveLogging({
                enabled: loggingEnabled,
                level: logLevel,
              })}
          >
            Apply
          </Button>
        </div>
      </div>
    </Card>

    <Card>
      <form class="flex flex-col gap-4" onsubmit={save}>
        <fieldset class="flex flex-col gap-2 border-0 p-0">
          <legend
            class="mb-1 text-xs font-semibold uppercase tracking-wider text-surface-600-400"
          >
            Proxy mode
          </legend>
          <Field label="Mode" forId="proxy-mode">
            <Select
              id="proxy-mode"
              bind:value={mode}
              options={modeOptions}
              disabled={appSettings.saving}
            />
          </Field>
          <p class="text-xs text-surface-600-400">
            System follows the operating system settings. Manual routes HTTP and
            HTTPS through the proxy below, using the scheme you enter.
          </p>
        </fieldset>

        {#if mode === 'manual'}
          <fieldset
            class="flex flex-col gap-3 border-0 border-t border-surface-200-800 p-0 pt-4"
          >
            <legend
              class="text-xs font-semibold uppercase tracking-wider text-surface-600-400"
            >
              Manual proxy
            </legend>
            <Field
              label="Proxy address"
              forId="proxy-address"
              hint="Accepts host:port, http://host:port or https://host:port. The port defaults to 80/443; the scheme is preserved."
            >
              <TextField
                id="proxy-address"
                bind:value={address}
                placeholder="http://127.0.0.1:7890"
                autocomplete="off"
                spellcheck="false"
                disabled={appSettings.saving}
              />
            </Field>

            <Field
              label="Bypass list (optional)"
              forId="proxy-bypass"
              hint="Comma-separated hosts that connect directly, without the proxy."
            >
              <TextField
                id="proxy-bypass"
                bind:value={bypass}
                placeholder="localhost,127.0.0.1"
                autocomplete="off"
                spellcheck="false"
                disabled={appSettings.saving}
              />
            </Field>
          </fieldset>
        {/if}

        {#if appSettings.proxy.resolved}
          <p class="text-xs text-surface-600-400">
            Effective proxy:
            <code class="font-mono text-surface-950-50"
              >{appSettings.proxy.resolved}</code
            >
          </p>
        {/if}

        <div class="flex justify-end border-t border-surface-200-800 pt-4">
          <Button type="submit" loading={appSettings.saving} loadingLabel="Saving…" disabled={!canSave}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  </div>
</section>
