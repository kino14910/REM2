<!--
  Custom title bar (Electron "Custom Title Bar" tutorial).

  The native title bar is removed by `titleBarStyle: 'hidden'` in
  `host/electron/window.ts`; this bar replaces it and is the window's only drag
  region. The native window controls are kept on Windows/Linux
  (`titleBarOverlay`), so the content is inset with the Window Controls Overlay
  safe-area variables: `titlebar-area-x` / `-width` / `-height` keep the bar
  clear of the buttons, which may sit on the left in RTL or be user-repositioned.

  Content is centered on purpose: on macOS the traffic lights are overlaid on
  the top-left and there is no Web API to reserve their space, so anything
  left-aligned would collide with them.
-->
<header class="titlebar">
  <span class="brand">rem2-kernel</span>
  <span class="divider" aria-hidden="true">·</span>
  <span class="subtitle">Kernel Console</span>
</header>

<style>
  .titlebar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--rem2-space-sm);
    /* Must match TITLE_BAR_HEIGHT in host/electron/window.ts (native overlay height). */
    height: env(titlebar-area-height, var(--rem2-titlebar-height));
    width: env(titlebar-area-width, 100%);
    margin-left: env(titlebar-area-x, 0);
    box-sizing: border-box;
    background: var(--rem2-color-surface);
    border-bottom: 1px solid var(--rem2-color-border);
    color: var(--rem2-color-text-muted);
    font-size: 12px;
    user-select: none;
    app-region: drag;
  }
  .brand {
    color: var(--rem2-color-text);
    font-weight: 600;
    letter-spacing: 0.4px;
  }
  .divider {
    opacity: 0.5;
  }
</style>
