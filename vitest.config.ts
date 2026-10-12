import { defineConfig } from 'vitest/config';
import { KERNEL_ALIAS } from './vite.shared.mjs';

/**
 * Vitest 配置。
 *
 * - 运行环境：node（内核是纯 Node 库，绝不依赖 Electron / DOM）。
 * - pool：threads（隔离好、启动快）。
 * - 别名 rem2-kernel → src/kernel/index.ts：与 vite 共享同一份来源，
 *   消除「同一 alias 声明多处」的漂移（docs/09 O21）。
 *
 * ## 并发与超时（重要）
 *
 * 集成测试每个用例都会：物化临时插件目录 → 启动真实内核（含定时器与超时保护）→
 * 逆序关闭 → 递归删除临时目录。这是 **CPU + Windows 文件 IO 双高负载** 的用例。
 * 若按默认并发（= CPU 核数）全部并行，进程间会互相饿死，表现为
 * `Hook timed out in 15000ms`（afterEach 的临时目录清理超时），**并非真实缺陷**。
 * 实测：默认并发下 transform 耗时 86s 且出现 5 个文件超时；
 * 限制到 maxWorkers=2 后 transform 降至 1.9s、26 文件 203 测试全绿。
 *
 * 因此这里显式限制 worker 数并放宽超时，保证结果**确定性**（不随机器核数漂移）。
 */
export default defineConfig({
  test: {
    environment: 'node',
    pool: 'threads',
    include: ['tests/**/*.test.ts'],
    globals: false,
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/kernel/**/*.ts'],
      // index.ts 是纯 re-export、contracts 是纯类型、definitions 是纯声明表 ——
      // 计入覆盖率无意义。
      exclude: [
        'src/kernel/index.ts',
        'src/kernel/contracts/**',
        'src/kernel/extensions/definitions.ts',
      ],
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 85,
        branches: 80,
      },
    },
  },
  resolve: {
    alias: {
      'rem2-kernel': KERNEL_ALIAS,
    },
  },
});
