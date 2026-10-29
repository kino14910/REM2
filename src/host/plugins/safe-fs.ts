import { constants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
} from 'node:fs/promises'
import path from 'node:path'
import { PluginManagementError } from './errors.js'

const MAX_FILES = 2000
const MAX_BYTES = 100 * 1024 * 1024

interface CopyOptions {
  skipExisting?: boolean
}

export function assertInside(
  root: string,
  target: string,
  label: string,
): void {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    throw new PluginManagementError(
      'E_PATH_ESCAPE',
      `${label} escapes its managed root`,
    )
  }
}

export async function readJsonFile(filePath: string): Promise<unknown> {
  const stat = await lstat(filePath)
  if (!stat.isFile() || stat.size > 1024 * 1024) {
    throw new PluginManagementError(
      'E_MANIFEST_INVALID',
      'plugin.json must be a file smaller than 1 MiB',
    )
  }
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown
  } catch (error) {
    throw new PluginManagementError(
      'E_MANIFEST_INVALID',
      'plugin.json is not valid JSON',
      {
        cause: error,
      },
    )
  }
}

export async function copyDirectorySafe(
  source: string,
  destination: string,
  options: CopyOptions = {},
): Promise<void> {
  const budget = { files: 0, bytes: 0 }
  await copyDirectory(source, destination, options, budget)
}

async function copyDirectory(
  source: string,
  destination: string,
  options: CopyOptions,
  budget: { files: number; bytes: number },
): Promise<void> {
  const stat = await lstat(source)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new PluginManagementError(
      'E_UNSAFE_TREE',
      `plugin tree contains an unsupported entry: ${source}`,
    )
  }
  await mkdir(destination, { recursive: true })
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isSymbolicLink()) {
      throw new PluginManagementError(
        'E_UNSAFE_TREE',
        `symbolic links are not allowed: ${from}`,
      )
    }
    if (entry.isDirectory()) {
      await copyDirectory(from, to, options, budget)
      continue
    }
    if (!entry.isFile()) {
      throw new PluginManagementError(
        'E_UNSAFE_TREE',
        `unsupported file type: ${from}`,
      )
    }
    const fileStat = await lstat(from)
    budget.files += 1
    budget.bytes += fileStat.size
    if (budget.files > MAX_FILES || budget.bytes > MAX_BYTES) {
      throw new PluginManagementError(
        'E_PACKAGE_TOO_LARGE',
        'plugin package exceeds file or size limits',
      )
    }
    if (options.skipExisting) {
      try {
        await copyFile(from, to, constants.COPYFILE_EXCL)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    } else {
      await copyFile(from, to, constants.COPYFILE_EXCL)
    }
  }
}

export async function assertRealDirectoryInside(
  root: string,
  target: string,
): Promise<void> {
  const [realRoot, realTarget] = await Promise.all([
    realpath(root),
    realpath(target),
  ])
  assertInside(realRoot, realTarget, 'plugin directory')
  if (path.resolve(realRoot) !== path.resolve(root)) {
    throw new PluginManagementError(
      'E_PATH_ESCAPE',
      'plugin root must not be a symbolic link',
    )
  }
}
