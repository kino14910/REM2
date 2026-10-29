/**
 * Kernel semantic topic constants.
 *
 * Plugins and the kernel communicate through Topics constants instead of
 * scattered literals: the contract is code.
 */

export const Topics = {
  /** Lifecycle / system */
  KernelReady: 'kernel.ready',
  KernelShutdown: 'kernel.shutdown',
  PluginStateChanged: 'kernel.plugin.state-changed',
  PluginDegraded: 'kernel.plugin.degraded',
  PluginFailed: 'kernel.plugin.failed',
  PluginReloaded: 'kernel.plugin.reloaded',
  PluginUnloaded: 'kernel.plugin.unloaded',
  /** Host-originated remote package download progress (forwarded to the renderer). */
  PluginDownloadProgress: 'plugin.download.progress',

  /** Configuration */
  ConfigChanged: 'config.changed',

  /** Commands (commonly used by feature plugins) */
  CommandExecute: 'command.execute',
  CommandResult: 'command.result',

  /** UI (consumed by the frontend via an IPC allowlist; raw plugin events never leak) */
  UiThemeChanged: 'ui.theme.changed',
  /** Plugins proactively push panel data refreshes (`panel.data-changed`). */
  PanelDataChanged: 'ui.panel.data-changed',

  /** Health */
  HealthRequest: 'health.request',
} as const

export type TopicKey = keyof typeof Topics

/** Union of topic values (`'kernel.ready' | 'command.execute' | ...`). */
export type TopicValue = (typeof Topics)[keyof typeof Topics]
