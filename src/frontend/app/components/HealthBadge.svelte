<!-- Health status badge: reads the health report via the health.report allowlisted method. -->
<script lang="ts">
  import { health } from '@/frontend/lib/stores/health.svelte'
  import Badge from '@/frontend/lib/ui/Badge.svelte'
  import type { BadgeTone } from '@/frontend/lib/ui/types'

  const tone = $derived<BadgeTone>(
    health.status === 'healthy'
      ? 'success'
      : health.status === 'unhealthy'
        ? 'error'
        : 'warning',
  )
</script>

<span class="flex items-center gap-2 font-mono text-xs">
  <Badge {tone}>{health.status}</Badge>
  {#if health.unhealthy.length > 0}
    <span class="text-surface-600-400">({health.unhealthy.length})</span>
  {/if}
</span>
