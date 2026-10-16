/**
 * 内核 topic → 对外事件名的**降维映射**（host 与 frontend 的共同来源）。
 *
 * ★ 为什么单独成文件（而不是留在 `electron/main.ts`）：
 * 这是契约的**第三份副本**，也是唯一能把「内核 topic 真值」与「前端事件白名单」
 * 对上号的地方。若它留在 import `electron` 的 main.ts 里，测试环境碰不到它，
 * 于是三方镜像（topics.ts / channels.ts / 本文件）各自手抄、互不相认 ——
 * 这正是过去多个静默缺陷的成因。抽出来后 `tests/contract/plugin-contract.test.ts`
 * 可以直接断言「topic 必须是 Topics 的真值」且「event 必须在 ALLOWED_EVENTS 里」。
 *
 * 只列白名单里的 5 个事件；每个 mapper 只投影必要字段（docs/04 §5.3 的 DTO 化意义：
 * 内核 `PluginInfo` / `HealthReport` 含 container、permissions、绝对路径，绝不能外泄）。
 */

import { Topics } from '../../kernel/topics.js';
import type { EventForwardMap } from './bridge.js';
import type { ThemeDefinition } from '../../kernel/contracts/ui.js';
import type { PluginStateT } from '../../kernel/contracts/plugins.js';

export const EVENT_FORWARD_MAP: EventForwardMap = [
  {
    topic: Topics.UiThemeChanged,
    event: 'ui.theme.changed',
    toDto: (p) => p as ThemeDefinition,
  },
  {
    topic: Topics.PluginStateChanged,
    event: 'plugin.state-changed',
    toDto: (p) => {
      const v = p as { pluginId: string; state: PluginStateT };
      return { pluginId: v.pluginId, state: v.state };
    },
  },
  {
    topic: Topics.PanelDataChanged,
    event: 'panel.data-changed',
    toDto: (p) => p,
  },
  {
    topic: Topics.CommandResult,
    event: 'command.result',
    toDto: (p) => p,
  },
  {
    topic: Topics.KernelReady,
    event: 'kernel.ready',
    toDto: (p) => p,
  },
];
