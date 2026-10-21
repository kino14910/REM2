/**
 * Kernel topic -> external event name reduction map (the shared source for host
 * and frontend).
 *
 * Why a separate file (instead of staying in `electron/main.ts`): this is the
 * third mirror of the contract and the only place where kernel topic values and
 * the frontend event whitelist can be reconciled. If it stayed in main.ts, which
 * imports `electron`, tests could not reach it, so the three mirrors (topics.ts /
 * channels.ts / this file) would each be hand-copied and never cross-checked -
 * the root cause of several past silent defects. Extracted here,
 * `tests/contract/plugin-contract.test.ts` can directly assert that every topic
 * is a true `Topics` value and every event is in the whitelist.
 *
 * Shape: `Record<AllowedEvent, ...>` with computed keys.
 * - Keys are the true `events.*` names, so external event names appear exactly
 *   once in the repo (in `shared/ipc-contract.ts`);
 * - `Record` requires an entry for every whitelisted event, so a missing entry
 *   is a missing key = compile error;
 * - `topic` is narrowed to `TopicValue`, so a mistyped topic is a compile error.
 * Both "mistyped" and "missing" defects are thus downgraded from silent runtime
 * failures to compile-time errors.
 *
 * Only the 5 whitelisted events are listed; each mapper projects only the
 * necessary fields (DTO reduction matters because kernel `PluginInfo` /
 * `HealthReport` carry container, permissions and absolute paths that must never
 * leak).
 */

import { Topics } from '../../kernel/topics.js'
import { events } from '../../shared/ipc-contract.js'
import type { EventForwardMap } from './bridge.js'
import type { ThemeDefinition } from '../../kernel/contracts/ui.js'
import type { PluginStateT } from '../../kernel/contracts/plugins.js'

export const EVENT_FORWARD_MAP = {
  [events.themeChanged]: {
    topic: Topics.UiThemeChanged,
    toDto: p => p as ThemeDefinition,
  },
  [events.pluginStateChanged]: {
    topic: Topics.PluginStateChanged,
    toDto: p => {
      const v = p as { pluginId: string; state: PluginStateT }
      return { pluginId: v.pluginId, state: v.state }
    },
  },
  [events.panelDataChanged]: {
    topic: Topics.PanelDataChanged,
    toDto: p => p,
  },
  [events.commandResult]: {
    topic: Topics.CommandResult,
    toDto: p => p,
  },
  [events.kernelReady]: {
    topic: Topics.KernelReady,
    toDto: p => p,
  },
} satisfies EventForwardMap
