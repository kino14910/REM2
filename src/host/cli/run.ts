/**
 * CLI bootstrap (`pnpm dev`).
 *
 * This is the executable entry of the kernel: the kernel itself is a pure
 * library, and the Electron shell is only an optional carrier.
 */

import path from 'node:path'
import process from 'node:process'
import { Kernel } from '../../kernel/kernel.js'
import { createDeps } from '../../kernel/composition.js'
import { parseArgs } from './args.js'
import { projectRoot, builtinPluginsRoot } from './paths.js'

/** Run the kernel until a shutdown signal is received. */
export async function run(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const args = parseArgs(argv)
  const root = projectRoot()

  const builtinRoot = args.builtinPluginsRoot ?? builtinPluginsRoot(root)
  const extraRoots = args.pluginRoots.slice()

  const kernel = new Kernel(
    createDeps({
      id: args.id,
      roots: extraRoots,
      builtinRoot,
      ...(args.configPath
        ? { configPath: path.resolve(root, args.configPath) }
        : {}),
      startTimeoutMs: args.startTimeoutMs,
      stopTimeoutMs: args.stopTimeoutMs,
      legacyFallback: args.legacyFallback,
      logLevel: args.logLevel,
      onResolveError: 'graceful',
      initialConfig: { app: { greeting: 'Hello from rem2-kernel' } },
    }),
  )

  const result = await kernel.start()
  const report = await kernel.health()

  const write = (s: string): void => {
    process.stdout.write(`${s}\n`)
  }

  write('──── rem2-kernel started ────')
  write(`loadOrder : ${result.loadOrder.join(' -> ')}`)
  write(`started   : ${result.started.join(', ') || '(none)'}`)
  write(`degraded  : ${result.degraded.join(', ') || '(none)'}`)
  write(`failed    : ${result.failed.join(', ') || '(none)'}`)
  write(`health    : ${report.status}`)
  for (const p of report.plugins) {
    write(
      `  - ${p.id} [${p.state}] ${p.status}${p.message ? ` (${p.message})` : ''}`,
    )
  }
  write('─────────────────────────────')

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    write(`\nReceived signal ${signal}, shutting down...`)
    await kernel.shutdown()
    write('Shutdown complete.')
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGHUP', () => void shutdown('SIGHUP'))

  if (args.exitAfterStart) {
    await shutdown('EXIT_AFTER_START')
  }
}

// Direct-execution entry (tsx src/host/cli/run.ts).
const isMain = (() => {
  try {
    const entry = process.argv[1] ?? ''
    return (
      entry.endsWith('run.ts') ||
      entry.endsWith('run.js') ||
      entry.endsWith('cli.ts')
    )
  } catch {
    return false
  }
})()

if (isMain) {
  void run().catch(error => {
    process.stderr.write(`Kernel startup failed: ${(error as Error).message}\n`)
    process.exitCode = 1
  })
}
