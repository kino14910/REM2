import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractZipSafe } from '../../src/host/plugins/zip-extract.js'
import { buildZip, type ZipBuilderEntry } from '../helpers/zip-builder.js'

describe('unit · safe ZIP extraction', () => {
  let root: string
  let zipPath: string
  let destination: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-zip-'))
    zipPath = path.join(root, 'package.zip')
    destination = path.join(root, 'output')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function archive(entries: readonly ZipBuilderEntry[]): Promise<string> {
    await writeFile(zipPath, buildZip(entries))
    return zipPath
  }

  it('extracts stored and deflated files and counts file bytes', async () => {
    const manifest = '{"id":"com.example.plugin"}'
    const source = 'export const answer = 42\n'
    await archive([
      { name: 'plugin.json', content: manifest, method: 0 },
      { name: 'src/', method: 0 },
      { name: 'src/index.js', content: source, method: 8 },
    ])
    const result = await extractZipSafe(zipPath, destination)
    expect(result).toEqual({
      root: destination,
      files: 2,
      bytes: Buffer.byteLength(manifest) + Buffer.byteLength(source),
    })
    expect(await readFile(path.join(destination, 'plugin.json'), 'utf8')).toBe(
      manifest,
    )
    expect(
      await readFile(path.join(destination, 'src', 'index.js'), 'utf8'),
    ).toBe(source)
  })

  it('unwraps a single top-level directory containing plugin.json', async () => {
    await archive([
      {
        name: 'repo-main/plugin.json',
        content: '{"id":"com.example.plugin"}',
        method: 8,
      },
      { name: 'repo-main/index.js', content: 'export {}', method: 0 },
    ])
    const result = await extractZipSafe(zipPath, destination)
    expect(result.root).toBe(path.join(destination, 'repo-main'))
    expect(result.files).toBe(2)
  })

  it.each([
    ['parent traversal', '../evil.txt'],
    ['absolute POSIX path', '/tmp/evil.txt'],
    ['Windows drive path', 'C:/evil.txt'],
    ['backslash traversal', '..\\evil.txt'],
    ['empty path segment', 'folder//evil.txt'],
    ['unsafe directory entry', '../'],
  ])('rejects %s', async (_label, name) => {
    await archive([{ name, content: 'evil' }])
    await expect(extractZipSafe(zipPath, destination)).rejects.toMatchObject({
      code: 'E_PATH_ESCAPE',
    })
    await expect(readFile(path.join(root, 'evil.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects symbolic links from Unix external attributes', async () => {
    await archive([
      { name: 'linked-file', content: '/etc/passwd', unixMode: 0o120777 },
    ])
    await expect(extractZipSafe(zipPath, destination)).rejects.toMatchObject({
      code: 'E_UNSAFE_TREE',
    })
  })

  it('rejects special files from Unix external attributes', async () => {
    await archive([{ name: 'fifo', unixMode: 0o010644 }])
    await expect(extractZipSafe(zipPath, destination)).rejects.toMatchObject({
      code: 'E_UNSAFE_TREE',
    })
  })

  it('enforces the file count limit and cleans earlier writes', async () => {
    await archive([
      { name: 'first.txt', content: 'first' },
      { name: 'second.txt', content: 'second' },
    ])
    await expect(
      extractZipSafe(zipPath, destination, { maxFiles: 1 }),
    ).rejects.toMatchObject({ code: 'E_PACKAGE_TOO_LARGE' })
    expect(await readdir(destination)).toEqual([])
  })

  it('enforces total expanded bytes and cleans earlier writes', async () => {
    await archive([
      { name: 'first.txt', content: 'abc', method: 8 },
      { name: 'second.txt', content: 'def', method: 8 },
    ])
    await expect(
      extractZipSafe(zipPath, destination, { maxTotalBytes: 5 }),
    ).rejects.toMatchObject({ code: 'E_PACKAGE_TOO_LARGE' })
    expect(await readdir(destination)).toEqual([])
  })

  it('enforces the per-entry expanded size limit', async () => {
    await archive([{ name: 'large.txt', content: 'abcd', method: 8 }])
    await expect(
      extractZipSafe(zipPath, destination, { maxEntryBytes: 3 }),
    ).rejects.toMatchObject({ code: 'E_PACKAGE_TOO_LARGE' })
    expect(await readdir(destination)).toEqual([])
  })

  it('rejects a CRC32 mismatch and removes the written file', async () => {
    await archive([{ name: 'corrupt.txt', content: 'actual bytes', crc: 0 }])
    await expect(extractZipSafe(zipPath, destination)).rejects.toMatchObject({
      code: 'E_PACKAGE_INVALID',
    })
    expect(await readdir(destination)).toEqual([])
  })

  it('rejects input without an end of central directory', async () => {
    await writeFile(zipPath, 'this is not a zip archive')
    await expect(extractZipSafe(zipPath, destination)).rejects.toMatchObject({
      code: 'E_PACKAGE_INVALID',
    })
  })

  it('rejects a corrupt local header offset', async () => {
    await archive([
      { name: 'plugin.json', content: '{}', localHeaderOffset: 2 },
    ])
    await expect(extractZipSafe(zipPath, destination)).rejects.toMatchObject({
      code: 'E_PACKAGE_INVALID',
    })
  })
})
