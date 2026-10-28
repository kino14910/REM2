/**
 * CLI argument parsing (hand-rolled with zero dependencies, to avoid
 * pulling in commander/yargs).
 */

import process from 'node:process'
import type { LogLevel } from '../../kernel/contracts/logging.js'

export interface KernelBootstrapArgs {
  id: string
  pluginRoots: string[]
  builtinPluginsRoot?: string
  configPath?: string
  startTimeoutMs: number
  stopTimeoutMs: number
  legacyFallback: boolean
  logLevel: LogLevel
  /** Exit immediately after startup (for CI/smoke runs). */
  exitAfterStart: boolean
}

/** Parse argv. The `KernelBootstrapArgs` shape mirrors the command-line-expressible subset of `KernelOptions`. */
export function parseArgs(argv: string[]): KernelBootstrapArgs {
  const args: KernelBootstrapArgs = {
    id: 'rem2-kernel',
    pluginRoots: [],
    startTimeoutMs: 5000,
    stopTimeoutMs: 5000,
    legacyFallback: false,
    logLevel: 'info',
    exitAfterStart: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    const [flag, inlineValue] = splitFlag(arg)
    const value = (): string | undefined => inlineValue ?? argv[++i]

    switch (flag) {
      case '--id':
        args.id = value() ?? args.id
        break
      case '--plugin-root':
      case '-p': {
        const v = value()
        if (v) args.pluginRoots.push(v)
        break
      }
      case '--builtin-root': {
        const v = value()
        if (v) args.builtinPluginsRoot = v
        break
      }
      case '--config': {
        const v = value()
        if (v) args.configPath = v
        break
      }
      case '--start-timeout':
        args.startTimeoutMs = toInt(value(), args.startTimeoutMs)
        break
      case '--stop-timeout':
        args.stopTimeoutMs = toInt(value(), args.stopTimeoutMs)
        break
      case '--legacy-fallback':
        args.legacyFallback = true
        break
      case '--log-level': {
        const v = value()
        if (isLogLevel(v)) args.logLevel = v
        break
      }
      case '--exit-after-start':
        args.exitAfterStart = true
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      default:
        break
    }
  }

  return args
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf('=')
  if (eq >= 0) {
    return [arg.slice(0, eq), arg.slice(eq + 1)]
  }
  return [arg, undefined]
}

function toInt(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback
  const n = Number.parseInt(v, 10)
  return Number.isNaN(n) ? fallback : n
}

function isLogLevel(v: string | undefined): v is LogLevel {
  return (
    v === 'trace' ||
    v === 'debug' ||
    v === 'info' ||
    v === 'warn' ||
    v === 'error' ||
    v === 'fatal'
  )
}

function printHelp(): void {
  process.stdout.write(
    [
      'rem2-kernel bootstrap',
      '',
      'Usage: tsx src/host/cli/run.ts [options]',
      '',
      'Options:',
      '  --id <id>                Kernel instance id (default: rem2-kernel)',
      '  -p, --plugin-root <dir>  Additional plugin root directory (repeatable)',
      '  --builtin-root <dir>     Built-in plugins directory',
      '  --config <path>          Config file path (passed through to the config provider)',
      '  --start-timeout <ms>     Per-plugin start timeout (default: 5000)',
      '  --stop-timeout <ms>      Per-plugin stop timeout (default: 5000)',
      '  --legacy-fallback        Enable legacy manifest.json compatibility',
      '  --log-level <level>      trace|debug|info|warn|error|fatal',
      '  --exit-after-start       Exit immediately after startup (smoke test)',
      '  -h, --help               Show help',
      '',
    ].join('\n'),
  )
}
