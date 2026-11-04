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

  The resolved bar colors are reported to the host (`lib/theme/vars.ts`) so the
  OS-painted window-controls overlay follows the same theme.
-->
<header
  data-titlebar
  class="flex h-[env(titlebar-area-height,var(--rem2-titlebar-height))] w-[env(titlebar-area-width,100%)] ml-[env(titlebar-area-x,0px)] items-center justify-center gap-2 border-b border-surface-200-800 bg-surface-100-900 text-xs text-surface-600-400 select-none [app-region:drag]"
>
  <span class="font-semibold tracking-wide text-surface-950-50">rem2-kernel</span>
  <span class="opacity-50" aria-hidden="true">·</span>
  <span>Kernel Main</span>
</header>
