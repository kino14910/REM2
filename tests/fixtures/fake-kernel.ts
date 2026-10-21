import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export interface InlinePlugin {
  id: string
  name?: string
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  /** Capability declarations (what this plugin needs). */
  requires?: string[]
  /** Extension point contributions (what this plugin provides). */
  contributes?: Array<{ point: string; id: string }>
  /** onStart behavior. */
  behavior?: 'ok' | 'throw' | { delayMs: number }
  health?: string
}

/** Generate plugin source (ESM, default-exported factory function). */
function sourceFor(p: InlinePlugin): string {
  const behavior = p.behavior ?? 'ok'
  let startBody = ''
  if (behavior === 'throw') {
    startBody = `throw new Error('${p.id} start failed');`
  } else if (typeof behavior === 'object') {
    startBody = `await new Promise((r) => setTimeout(r, ${behavior.delayMs}));`
  }

  // Declarative contributions: project each manifest.contributes entry into ctx.extensions.
  const contributeLines = (p.contributes ?? [])
    .map(
      c =>
        `    ctx.extensions.contribute(${JSON.stringify(c.point)}, { contributionId: ${JSON.stringify(c.id)}, impl: { id: ${JSON.stringify(c.id)} } });`,
    )
    .join('\n')

  return `
export default function factory(ctx) {
  return {
    async onConfigure() { /* noop */ },
    async onStart() {
${startBody}
${contributeLines}
    },
    async onStop() { /* noop */ },
    async onUnload() { /* noop */ },
    async onDispose() { /* noop */ },
    onHealthCheck() { return ${JSON.stringify(p.health ?? 'healthy')} },
  }
}
`
}

export async function materializePlugins(
  plugins: InlinePlugin[],
  prefix = 'rem2-fixture-',
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  for (const p of plugins) {
    const dir = path.join(root, p.id.replace(/[^a-z0-9._-]/gi, '_'))
    await mkdir(dir, { recursive: true })
    const manifest = {
      id: p.id,
      name: p.name ?? p.id,
      version: p.version ?? '1.0.0',
      entry: 'index.js',
      compatibility: { minKernel: '^1.0.0', contractVersion: '1' },
      ...(p.dependencies ? { dependencies: p.dependencies } : {}),
      ...(p.optionalDependencies
        ? { optionalDependencies: p.optionalDependencies }
        : {}),
      ...(p.requires ? { requires: p.requires } : {}),
      ...(p.contributes ? { contributes: p.contributes } : {}),
    }
    await writeFile(
      path.join(dir, 'plugin.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    )
    await writeFile(path.join(dir, 'index.js'), sourceFor(p), 'utf8')
  }
  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true })
    },
  }
}
