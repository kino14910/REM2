import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { PluginManagementError } from './errors.js'
import { assertInside } from './safe-fs.js'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const DEFAULT_MAX_FILES = 2000
const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024
const DEFAULT_MAX_ENTRY_BYTES = 25 * 1024 * 1024

export interface ExtractLimits {
  maxFiles?: number
  maxTotalBytes?: number
  maxEntryBytes?: number
}

export interface ExtractResult {
  root: string
  files: number
  bytes: number
}

interface ZipEntry {
  name: string
  nameBytes: Buffer
  flags: number
  method: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  directory: boolean
  target: string
}

export async function extractZipSafe(
  zipPath: string,
  destination: string,
  limits: ExtractLimits = {},
): Promise<ExtractResult> {
  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  const maxEntryBytes = limits.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES
  let archive: Buffer
  try {
    archive = await readFile(zipPath)
  } catch (error) {
    throw new PluginManagementError(
      'E_PACKAGE_INVALID',
      `cannot read ZIP package: ${zipPath}`,
      { cause: error },
    )
  }

  const entries = parseArchive(archive, destination)
  const writtenFiles: string[] = []
  let files = 0
  let bytes = 0
  try {
    await mkdir(destination, { recursive: true })
    for (const entry of entries) {
      if (entry.directory) {
        await mkdir(entry.target, { recursive: true })
        continue
      }
      files += 1
      bytes += entry.uncompressedSize
      if (files > maxFiles) {
        throw new PluginManagementError(
          'E_PACKAGE_TOO_LARGE',
          `ZIP package exceeds the ${maxFiles} file limit`,
        )
      }
      if (entry.uncompressedSize > maxEntryBytes) {
        throw new PluginManagementError(
          'E_PACKAGE_TOO_LARGE',
          `ZIP entry ${entry.name} exceeds the ${maxEntryBytes} byte limit`,
        )
      }
      if (bytes > maxTotalBytes) {
        throw new PluginManagementError(
          'E_PACKAGE_TOO_LARGE',
          `ZIP package exceeds the ${maxTotalBytes} byte total size limit`,
        )
      }

      const content = inflateEntry(archive, entry)
      await mkdir(path.dirname(entry.target), { recursive: true })
      await writeFile(entry.target, content, { flag: 'wx' })
      writtenFiles.push(entry.target)
    }
    return {
      root: await findPackageRoot(destination),
      files,
      bytes,
    }
  } catch (error) {
    for (const file of writtenFiles.toReversed()) {
      await rm(file, { force: true }).catch(() => undefined)
    }
    if (error instanceof PluginManagementError) throw error
    throw new PluginManagementError(
      'E_PACKAGE_INVALID',
      'failed to extract ZIP package',
      { cause: error },
    )
  }
}

function parseArchive(archive: Buffer, destination: string): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(archive)
  const disk = archive.readUInt16LE(eocdOffset + 4)
  const centralDisk = archive.readUInt16LE(eocdOffset + 6)
  const diskEntries = archive.readUInt16LE(eocdOffset + 8)
  const entryCount = archive.readUInt16LE(eocdOffset + 10)
  const centralSize = archive.readUInt32LE(eocdOffset + 12)
  const centralOffset = archive.readUInt32LE(eocdOffset + 16)
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw invalidPackage('multi-volume and ZIP64 archives are not supported')
  }
  const centralEnd = centralOffset + centralSize
  if (centralEnd > eocdOffset) {
    throw invalidPackage('central directory is outside the archive')
  }

  const entries: ZipEntry[] = []
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > centralEnd ||
      archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE
    ) {
      throw invalidPackage('invalid central directory entry')
    }
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const crc = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const uncompressedSize = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const diskStart = archive.readUInt16LE(cursor + 34)
    const externalAttributes = archive.readUInt32LE(cursor + 38)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const entryLength = 46 + nameLength + extraLength + commentLength
    if (cursor + entryLength > centralEnd) {
      throw invalidPackage('truncated central directory entry')
    }
    if (
      diskStart !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw invalidPackage('multi-volume and ZIP64 entries are not supported')
    }
    if ((flags & 0x2041) !== 0) {
      throw invalidPackage('encrypted ZIP entries are not supported')
    }
    if (method !== 0 && method !== 8) {
      throw invalidPackage(`unsupported ZIP compression method: ${method}`)
    }

    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = nameBytes.toString('utf8')
    const unixType = (externalAttributes >>> 16) & 0o170000
    if (unixType === 0o120000) {
      throw new PluginManagementError(
        'E_UNSAFE_TREE',
        `ZIP symbolic links are not allowed: ${name}`,
      )
    }
    if (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) {
      throw new PluginManagementError(
        'E_UNSAFE_TREE',
        `ZIP entry has an unsupported file type: ${name}`,
      )
    }
    const directory = name.endsWith('/') || unixType === 0o040000
    const target = safeEntryTarget(destination, name, directory)
    entries.push({
      name,
      nameBytes,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      directory,
      target,
    })
    validateLocalHeader(archive, entries[index], centralOffset)
    cursor += entryLength
  }
  if (cursor !== centralEnd) {
    throw invalidPackage('central directory size does not match its entries')
  }
  return entries
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const earliest = Math.max(0, archive.length - 22 - 0xffff)
  for (let offset = archive.length - 22; offset >= earliest; offset -= 1) {
    if (archive.readUInt32LE(offset) !== EOCD_SIGNATURE) continue
    const commentLength = archive.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === archive.length) return offset
  }
  throw invalidPackage('ZIP end of central directory was not found')
}

function validateLocalHeader(
  archive: Buffer,
  entry: ZipEntry,
  centralOffset: number,
): void {
  const offset = entry.localOffset
  if (
    offset + 30 > centralOffset ||
    archive.readUInt32LE(offset) !== LOCAL_SIGNATURE
  ) {
    throw invalidPackage(`invalid local header for ZIP entry: ${entry.name}`)
  }
  const flags = archive.readUInt16LE(offset + 6)
  const method = archive.readUInt16LE(offset + 8)
  const nameLength = archive.readUInt16LE(offset + 26)
  const extraLength = archive.readUInt16LE(offset + 28)
  if (
    flags !== entry.flags ||
    method !== entry.method ||
    (flags & 0x2041) !== 0 ||
    archive.readUInt32LE(offset + 18) === 0xffffffff ||
    archive.readUInt32LE(offset + 22) === 0xffffffff
  ) {
    throw invalidPackage(
      `inconsistent local header for ZIP entry: ${entry.name}`,
    )
  }
  const nameStart = offset + 30
  const dataStart = nameStart + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (
    dataEnd > centralOffset ||
    !archive.subarray(nameStart, nameStart + nameLength).equals(entry.nameBytes)
  ) {
    throw invalidPackage(`invalid local data for ZIP entry: ${entry.name}`)
  }
}

function safeEntryTarget(
  destination: string,
  name: string,
  directory: boolean,
): string {
  const unsafe =
    !name ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[a-z]:/i.test(name)
  if (unsafe) throw unsafePath(name)

  const segments = name.split('/')
  if (directory && segments.at(-1) === '') segments.pop()
  if (
    segments.length === 0 ||
    segments.some(
      segment =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':'),
    )
  ) {
    throw unsafePath(name)
  }
  const target = path.join(destination, ...segments)
  assertInside(destination, target, 'ZIP entry')
  return target
}

function inflateEntry(archive: Buffer, entry: ZipEntry): Buffer {
  const nameLength = archive.readUInt16LE(entry.localOffset + 26)
  const extraLength = archive.readUInt16LE(entry.localOffset + 28)
  const dataStart = entry.localOffset + 30 + nameLength + extraLength
  const compressed = archive.subarray(
    dataStart,
    dataStart + entry.compressedSize,
  )
  let content: Buffer
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      throw invalidPackage(`stored entry has inconsistent sizes: ${entry.name}`)
    }
    content = Buffer.from(compressed)
  } else {
    try {
      content = inflateRawSync(compressed, {
        maxOutputLength: entry.uncompressedSize + 1,
      })
    } catch (error) {
      throw new PluginManagementError(
        'E_PACKAGE_INVALID',
        `cannot inflate ZIP entry: ${entry.name}`,
        { cause: error },
      )
    }
  }
  if (content.byteLength !== entry.uncompressedSize) {
    throw invalidPackage(`inflated size does not match entry: ${entry.name}`)
  }
  if (crc32(content) !== entry.crc) {
    throw invalidPackage(`CRC32 mismatch for ZIP entry: ${entry.name}`)
  }
  return content
}

async function findPackageRoot(destination: string): Promise<string> {
  if (await isFile(path.join(destination, 'plugin.json'))) return destination
  const entries = await readdir(destination, { withFileTypes: true })
  if (
    entries.length === 1 &&
    entries[0].isDirectory() &&
    !entries[0].isSymbolicLink()
  ) {
    const nested = path.join(destination, entries[0].name)
    if (await isFile(path.join(nested, 'plugin.json'))) return nested
  }
  return destination
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function crc32(content: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of content) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function unsafePath(name: string): PluginManagementError {
  return new PluginManagementError(
    'E_PATH_ESCAPE',
    `unsafe path in ZIP package: ${name}`,
  )
}

function invalidPackage(message: string): PluginManagementError {
  return new PluginManagementError('E_PACKAGE_INVALID', message)
}
