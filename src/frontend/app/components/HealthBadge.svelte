<!-- Health status badge: reads the health report via the health.report allowlisted method. -->
<script lang="ts">
  import { health } from '../../lib/stores/health.svelte'
</script>

<span class="badge" data-status={health.status}>
  {health.report?.status ?? 'unknown'}
  {#if health.unhealthy.length > 0}
    <span class="count">({health.unhealthy.length})</span>
  {/if}
</span>

<style>
  .badge {
    font-size: 12px;
    font-family: var(--rem2-font-mono);
    color: var(--rem2-color-text-muted);
  }
  .badge[data-status='healthy'] {
    color: var(--rem2-color-accent);
  }
  .badge[data-status='unhealthy'] {
    color: #ff6b6b;
  }
  .count {
    margin-left: 4px;
  }
</style>
