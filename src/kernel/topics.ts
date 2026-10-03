/**
 * 内核语义主题常量（避免魔法字符串，动机 #4 的延伸）。
 *
 * 插件与内核通过 Topics 常量通信，而非散落的字面量；这是「契约即代码」的体现。
 */

export const Topics = {
  /** 生命周期/系统 */
  KernelReady: 'kernel.ready',
  KernelShutdown: 'kernel.shutdown',
  PluginStateChanged: 'kernel.plugin.state-changed',
  PluginDegraded: 'kernel.plugin.degraded',
  PluginFailed: 'kernel.plugin.failed',
  PluginReloaded: 'kernel.plugin.reloaded',
  PluginUnloaded: 'kernel.plugin.unloaded',

  /** 配置 */
  ConfigChanged: 'config.changed',

  /** 命令（业务功能插件常用） */
  CommandExecute: 'command.execute',
  CommandResult: 'command.result',

  /** UI（UI 外壳插件消费） */
  UiThemeRegistered: 'ui.theme.registered',
  UiThemeChanged: 'ui.theme.changed',

  /** 健康 */
  HealthRequest: 'health.request',
} as const;

export type TopicKey = keyof typeof Topics;
