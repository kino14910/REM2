/**
 * 扩展点契约（P3 原则的「语言」侧）。
 *
 * 扩展点是「宿主提供的可替换能力」的显式声明：id、单例/多贡献、宿主默认实现、
 * 冲突裁决策略、所需能力。任何「宿主能替换的东西」都必须在这里有 id，
 * 否则 `ctx.extensions.contribute` 无处可投（P3：一切经扩展点注册表）。
 */

import type { Capability } from './permission.js';

/**
 * 扩展点 id 联合。新增扩展点必须同时：
 * ① 在此加字面量；② 在 `extensions/definitions.ts` 加一条 `ExtensionPointDef`；
 * ③ 若有 capability，在 `permission.ts` 加常量并在 trust-policy 给出处置。
 */
export type ExtensionPointId =
  | 'log.sink'
  | 'metrics.sink'
  | 'trace.exporter'
  | 'config.provider'
  | 'command.provide'
  | 'health.check'
  | 'ui.theme'
  | 'ui.panel'
  | 'ui.route'
  | 'scheduler.replace'
  | 'resolver.replace'
  | 'loader.replace';

/** 冲突裁决策略（仅单例槽有意义）。 */
export type ExtensionConflictPolicy = 'reject-new' | 'replace-old' | 'keep-first';

/** 扩展点定义。 */
export interface ExtensionPointDef<T> {
  readonly id: ExtensionPointId;
  readonly describe: string;
  /** 多贡献 or 单例。单例由内核在注册时裁决冲突。 */
  readonly multi: boolean;
  /** 宿主是否提供默认实现（启动前注册，pluginId = 'kernel'）。 */
  readonly hasHostDefault: boolean;
  /** 冲突裁决策略（仅单例槽有意义）。 */
  readonly conflict: ExtensionConflictPolicy;
  /** 声明该扩展点需要的能力（插件贡献时必须被授予）。 */
  readonly capability?: Capability;
  /** 仅用于类型推断，运行期不存在。 */
  readonly __type?: T;
}

/** 单项贡献。 */
export interface ExtensionContribution<T> {
  /** 槽内唯一（单例槽用于裁决；多贡献槽用于回收与列表）。 */
  readonly contributionId: string;
  readonly impl: T;
}

/** 插件可见的贡献入口（`ctx.extensions` 的类型）。 */
export interface ExtensionContributorView {
  /** 贡献一个扩展点。未知 point id → 抛 UnknownExtensionPointError。 */
  contribute<T>(point: ExtensionPointId, contribution: ExtensionContribution<T>): void;
  /** 撤回本插件的某项贡献（通常不需要——卸载时内核强制回收全部）。 */
  retract(point: ExtensionPointId, contributionId: string): void;
}

/** 扩展点枚举条目（`registry.list()` 的返回项）。 */
export interface ExtensionPointSummary {
  point: ExtensionPointId;
  multi: boolean;
  contributions: string[];
}
