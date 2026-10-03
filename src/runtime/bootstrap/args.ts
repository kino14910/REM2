/**
 * CLI 参数解析（零依赖手写，避免引入 commander/yargs）。
 */

import process from 'node:process';
import type { LogLevel } from '../../kernel/contracts/logging.js';

/** 引导参数。 */
export interface KernelBootstrapArgs {
  id: string;
  /** 额外插件根（--plugin-root，可多次）。 */
  pluginRoots: string[];
  builtinPluginsRoot?: string;
  configPath?: string;
  startTimeoutMs: number;
  stopTimeoutMs: number;
  legacyFallback: boolean;
  logLevel: LogLevel;
  /** 仅启动后退出（CI/冒烟用）。 */
  exitAfterStart: boolean;
}

/** 解析 argv。 */
export function defaultKernelOptions(argv: string[]): KernelBootstrapArgs {
  const args: KernelBootstrapArgs = {
    id: 'rem2-kernel',
    pluginRoots: [],
    startTimeoutMs: 5000,
    stopTimeoutMs: 5000,
    legacyFallback: false,
    logLevel: 'info',
    exitAfterStart: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const [flag, inlineValue] = splitFlag(arg);
    const value = (): string | undefined => inlineValue ?? argv[++i];

    switch (flag) {
      case '--id':
        args.id = value() ?? args.id;
        break;
      case '--plugin-root':
      case '-p': {
        const v = value();
        if (v) args.pluginRoots.push(v);
        break;
      }
      case '--builtin-root': {
        const v = value();
        if (v) args.builtinPluginsRoot = v;
        break;
      }
      case '--config': {
        const v = value();
        if (v) args.configPath = v;
        break;
      }
      case '--start-timeout':
        args.startTimeoutMs = toInt(value(), args.startTimeoutMs);
        break;
      case '--stop-timeout':
        args.stopTimeoutMs = toInt(value(), args.stopTimeoutMs);
        break;
      case '--legacy-fallback':
        args.legacyFallback = true;
        break;
      case '--log-level': {
        const v = value();
        if (isLogLevel(v)) args.logLevel = v;
        break;
      }
      case '--exit-after-start':
        args.exitAfterStart = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        break;
    }
  }

  return args;
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf('=');
  if (eq >= 0) {
    return [arg.slice(0, eq), arg.slice(eq + 1)];
  }
  return [arg, undefined];
}

function toInt(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

function isLogLevel(v: string | undefined): v is LogLevel {
  return (
    v === 'trace' ||
    v === 'debug' ||
    v === 'info' ||
    v === 'warn' ||
    v === 'error' ||
    v === 'fatal'
  );
}

function printHelp(): void {
  process.stdout.write(
    [
      'rem2 内核引导',
      '',
      '用法：tsx src/runtime/bootstrap/run.ts [选项]',
      '',
      '选项：',
      '  --id <id>                内核实例 id（默认 rem2-kernel）',
      '  -p, --plugin-root <dir>  额外插件根目录（可多次）',
      '  --builtin-root <dir>     内建插件目录',
      '  --config <path>          配置文件路径（透传给 config provider）',
      '  --start-timeout <ms>     单插件启动超时（默认 5000）',
      '  --stop-timeout <ms>      单插件停止超时（默认 5000）',
      '  --legacy-fallback        启用旧式 manifest.json 兼容',
      '  --log-level <level>      trace|debug|info|warn|error|fatal',
      '  --exit-after-start       启动后立即退出（冒烟测试）',
      '  -h, --help               显示帮助',
      '',
    ].join('\n'),
  );
}
