/**
 * 扩展点声明表（P3 的「有哪些扩展点」的唯一来源）。
 *
 * 与 `docs/11 §7.2` 的全表**逐 id 一一对应**（PRD A7）。
 * 由 `tests/contract/extension-points.test.ts` 强制二者一致。
 *
 * 字段语义：
 * - `multi`：多贡献槽（false = 单例槽，冲突时按 `conflict` 裁决）。
 * - `hasHostDefault`：宿主是否在启动前 `registerHostDefault`（pluginId = 'kernel'）。
 * - `conflict`：仅单例槽有意义；不允许隐式默认。
 * - `capability`：插件贡献该扩展点时必须已被授予的能力。
 */

import type { ExtensionPointDef } from '../contracts/extension-point.js';
import type {
  LogSink,
  MetricSink,
  TraceExporter,
  ConfigProvider,
  HealthCheckFn,
  ThemeDefinition,
  PanelContribution,
  RouteContribution,
} from '../contracts/index.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type {
  CommandHandler,
  DependencyResolverPort,
  PluginLoaderPort,
} from './ports.js';

/** 扩展点定义表（有序；顺序即 `registry.list()` 的输出顺序）。 */
export const EXTENSION_POINT_DEFS = [
  {
    id: 'log.sink',
    describe: '日志输出目的地（console / file / remote）',
    multi: true,
    hasHostDefault: true,
    conflict: 'keep-first',
  },
  {
    id: 'metrics.sink',
    describe: '指标导出目的地',
    multi: true,
    hasHostDefault: true,
    conflict: 'keep-first',
  },
  {
    id: 'trace.exporter',
    describe: 'span 导出（otlp / console）',
    multi: true,
    hasHostDefault: true,
    conflict: 'keep-first',
  },
  {
    id: 'config.provider',
    describe: '配置层（json / env / remote）',
    multi: true,
    hasHostDefault: true,
    conflict: 'keep-first',
    capability: 'config.provide',
  },
  {
    id: 'command.provide',
    describe: '业务命令处理器（按 command 名去重）',
    multi: true,
    hasHostDefault: false,
    conflict: 'reject-new',
    capability: 'command.provide',
  },
  {
    id: 'health.check',
    describe: '插件健康自检函数',
    multi: true,
    hasHostDefault: false,
    conflict: 'keep-first',
  },
  {
    id: 'ui.theme',
    describe: '主题 token 定义（单例：当前激活主题）',
    multi: false,
    hasHostDefault: true,
    conflict: 'keep-first',
    capability: 'ui.theme',
  },
  {
    id: 'ui.panel',
    describe: '声明式 UI 面板描述（chrome 由宿主渲染）',
    multi: true,
    hasHostDefault: true,
    conflict: 'reject-new',
    capability: 'ui.panel',
  },
  {
    id: 'ui.route',
    describe: '声明式 UI 路由',
    multi: true,
    hasHostDefault: false,
    conflict: 'replace-old',
    capability: 'ui.route',
  },
  {
    id: 'scheduler.replace',
    describe: '替换内核调度器（并行 / 分队列）',
    multi: false,
    hasHostDefault: true,
    conflict: 'replace-old',
    capability: 'kernel.internals',
  },
  {
    id: 'resolver.replace',
    describe: '替换依赖解析策略',
    multi: false,
    hasHostDefault: true,
    conflict: 'replace-old',
    capability: 'kernel.internals',
  },
  {
    id: 'loader.replace',
    describe: '替换装载机制（如从注册中心拉取）',
    multi: false,
    hasHostDefault: true,
    conflict: 'replace-old',
    capability: 'kernel.internals',
  },
] as const satisfies readonly ExtensionPointDef<unknown>[];

/** 全部扩展点 id（有序）。 */
export const EXTENSION_POINT_IDS = EXTENSION_POINT_DEFS.map(
  (d) => d.id,
) as readonly ExtensionPointDef<unknown>['id'][];

/**
 * 扩展点 id → 贡献实现类型的映射。
 *
 * 单独一张表而非在 `def` 上放 `__type`，是因为 `def` 数组需要 `as const satisfies`
 * 才能保住字面量 id；泛型擦除后无法逐项携带不同的 `T`。
 */
export interface ExtensionPointImplMap {
  'log.sink': LogSink;
  'metrics.sink': MetricSink;
  'trace.exporter': TraceExporter;
  'config.provider': ConfigProvider;
  'command.provide': CommandHandler;
  'health.check': HealthCheckFn;
  'ui.theme': ThemeDefinition;
  'ui.panel': PanelContribution;
  'ui.route': RouteContribution;
  'scheduler.replace': Scheduler;
  'resolver.replace': DependencyResolverPort;
  'loader.replace': PluginLoaderPort;
}

/** 按 id 取定义（供启动期 `defineAll` 使用）。 */
export function findExtensionPointDef(
  id: string,
): ExtensionPointDef<unknown> | undefined {
  return EXTENSION_POINT_DEFS.find((d) => d.id === id);
}
