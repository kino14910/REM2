/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
declare module '*.css'

/**
 * Module declaration for Svelte components.
 *
 * `tsc` does not parse `.svelte` (that is the svelte compiler's job), so this
 * gives the minimal shape: a default export that `mount()` accepts. The real
 * types come from svelte-check / vite.
 */
declare module '*.svelte' {
  import type { Component } from 'svelte'
  const component: Component<Record<string, never>>
  export default component
}
