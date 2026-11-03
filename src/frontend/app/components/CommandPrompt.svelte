<!--
  Command input: invokes command.execute (one of the allowlisted methods).

  Skeleton stage: structure only -- send a command and show the last result.
  No command completion or history navigation.
-->
<script lang="ts">
  import { command } from '@/frontend/lib/stores/command.svelte'
  import Button from '@/frontend/lib/ui/Button.svelte'
  import TextField from '@/frontend/lib/ui/TextField.svelte'
  import { cn } from '@/frontend/lib/ui/cn'

  let input = $state('')

  function submit(e: SubmitEvent): void {
    e.preventDefault()
    const text = input.trim()
    if (!text) return
    void command.execute(text)
    input = ''
  }

  let resultText = $derived.by(() => {
    const last = command.last
    if (!last) return ''
    if (!last.ok) return last.error ?? 'failed'
    return last.output ?? 'ok'
  })
</script>

<form class="flex min-w-0 flex-1 items-center gap-2" onsubmit={submit}>
  <TextField
    bind:value={input}
    aria-label="Command"
    placeholder="Type a command and press Enter"
    disabled={command.running}
    class="min-w-0 flex-1"
    autocomplete="off"
    spellcheck="false"
  />
  <Button
    type="submit"
    size="sm"
    loading={command.running}
    loadingLabel="Running…"
    disabled={input.trim() === ''}
  >
    Run
  </Button>
  {#if command.last}
    <span
      class={cn(
        'max-w-64 truncate font-mono text-xs',
        command.last.ok ? 'text-surface-600-400' : 'text-error-500',
      )}
    >
      {resultText}
    </span>
  {/if}
</form>
