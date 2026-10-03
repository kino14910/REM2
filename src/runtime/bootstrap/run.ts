/**
 * CLI 引导（`pnpm dev`）。
 *
 * 职责：解析参数 → 构造 KernelOptions → start → 注册信号处理 → 打印健康报告。
 * 这是内核的可执行入口；内核本身是纯库，Electron 外壳只是可选载体（§A.1）。
 */

import path from 'node:path';
import process from 'node:process';
import { Kernel } from '../../kernel/kernel.js';
import { defaultKernelOptions } from './args.js';
import { projectRoot, builtinPluginsRoot, examplesDir } from './paths.js';

/**
 * 运行内核直到收到退出信号。
 */
export async function run(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const args = defaultKernelOptions(argv);
  const root = projectRoot();

  const builtinRoot = args.builtinPluginsRoot ?? builtinPluginsRoot(root);
  const extraRoots = args.pluginRoots.slice();

  const kernel = new Kernel({
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
    initialConfig: { app: { greeting: 'Hello from rem2' } },
  });

  const result = await kernel.start();
  const report = await kernel.health();

  const log = kernel.root
    ? { line: (s: string) => process.stdout.write(`${s}\n`) }
    : undefined;
  const write = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };

  write('──── rem2 kernel started ────');
  write(`loadOrder : ${result.loadOrder.join(' -> ')}`);
  write(`started   : ${result.started.join(', ') || '(none)'}`);
  write(`degraded  : ${result.degraded.join(', ') || '(none)'}`);
  write(`failed    : ${result.failed.join(', ') || '(none)'}`);
  write(`health    : ${report.status}`);
  for (const p of report.plugins) {
    write(
      `  - ${p.id} [${p.state}] ${p.status}${p.message ? ` (${p.message})` : ''}`,
    );
  }
  write('─────────────────────────────');
  void log;

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    write(`\n收到信号 ${signal}，正在关闭…`);
    await kernel.shutdown();
    write('已关闭。');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));

  if (args.exitAfterStart) {
    await shutdown('EXIT_AFTER_START');
  }
}

// 直接执行入口（tsx src/runtime/bootstrap/run.ts）。
const isMain = (() => {
  try {
    const entry = process.argv[1] ?? '';
    return (
      entry.endsWith('run.ts') ||
      entry.endsWith('run.js') ||
      entry.endsWith('cli.ts')
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  void run().catch((error) => {
    process.stderr.write(`内核启动失败：${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}

export { examplesDir };
