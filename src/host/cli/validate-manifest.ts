import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { validateManifest } from '../../kernel/discovery/manifest-validator.js'

export interface ValidateEntry {
  file: string
  ok: boolean
  issues: string[]
}

export async function validateManifestFile(
  filePath: string,
): Promise<ValidateEntry> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown
  } catch (error) {
    return {
      file: filePath,
      ok: false,
      issues: [`Parse failed: ${(error as Error).message}`],
    }
  }
  const result = validateManifest(raw)
  return {
    file: filePath,
    ok: result.ok,
    issues: result.issues.map(i => `${i.path}: ${i.message}`),
  }
}

/** Validate a target (a plugin.json file | a single plugin directory | a parent directory containing multiple plugins). */
export async function validateTarget(target: string): Promise<ValidateEntry[]> {
  const abs = path.resolve(target)
  const st = await stat(abs)

  if (st.isFile()) {
    return [await validateManifestFile(abs)]
  }

  // Case one: the target directory is itself a plugin (contains plugin.json).
  const selfManifest = path.join(abs, 'plugin.json')
  if (await exists(selfManifest)) {
    return [await validateManifestFile(selfManifest)]
  }

  // Case two: the target directory is a parent directory; probe each child directory's plugin.json in turn.
  const entries: ValidateEntry[] = []
  const children = await readdir(abs)
  for (const child of children.sort()) {
    const manifestPath = path.join(abs, child, 'plugin.json')
    if (!(await exists(manifestPath))) continue
    entries.push(await validateManifestFile(manifestPath))
  }
  return entries
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export async function runValidate(argv: string[]): Promise<number> {
  const target = argv[0]
  if (!target) {
    process.stderr.write('Usage: validate <plugin-dir | plugin.json>\n')
    return 2
  }

  const entries = await validateTarget(target)
  if (entries.length === 0) {
    process.stderr.write(`No plugin.json found to validate: ${target}\n`)
    return 2
  }

  let failed = 0
  for (const entry of entries) {
    if (entry.ok) {
      process.stdout.write(`✓ ${entry.file}\n`)
    } else {
      failed += 1
      process.stderr.write(`✗ ${entry.file}\n`)
      for (const issue of entry.issues) {
        process.stderr.write(`    - ${issue}\n`)
      }
    }
  }
  process.stdout.write(
    `\nValidation complete: ${entries.length - failed}/${entries.length} passed\n`,
  )
  return failed === 0 ? 0 : 1
}
