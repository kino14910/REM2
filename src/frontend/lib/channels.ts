/**
 * 前端可用的方法名 / 事件名常量。
 *
 * ★ 必须与 `src/host/ipc/channels.ts` 的白名单**逐条对应**。
 * 本文件刻意**不 import** 宿主那份：`src/frontend/**` 不得依赖 `src/host/**`
 * （契约测试 R8 / docs/03 §9.2 R6），所以这里是「按契约手抄的镜像」，
 * 由 `tests/contract/plugin-contract.test.ts` 断言两侧长度与内容一致。
 */

/** 8 个方法（与 `ALLOWED_METHODS` 一一对应）。 */
export const channels = {
  panelList: 'ui.panel.list',
  panelData: 'ui.panel.data',
  routeList: 'ui.route.list',
  themeList: 'ui.theme.list',
  themeSet: 'ui.theme.set',
  uiEvent: 'ui.event',
  commandExecute: 'command.execute',
  healthReport: 'health.report',
} as const;

export type MethodName = (typeof channels)[keyof typeof channels];

/** 5 个事件（与 `ALLOWED_EVENTS` 一一对应）。 */
export const events = {
  themeChanged: 'ui.theme.changed',
  pluginStateChanged: 'plugin.state-changed',
  panelDataChanged: 'panel.data-changed',
  commandResult: 'command.result',
  kernelReady: 'kernel.ready',
} as const;

export type EventName = (typeof events)[keyof typeof events];
