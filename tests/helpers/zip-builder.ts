import { deflateRawSync } from 'node:zlib'

export interface ZipBuilderEntry {
  name: string
  content?: string | Uint8Array
  method?: number
  unixMode?: number
  crc?: number
  localHeaderOffset?: number
  flags?: number
}

export function buildZip(entries: readonly ZipBuilderEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const content =
      typeof entry.content === 'string'
        ? Buffer.from(entry.content, 'utf8')
        : Buffer.from(entry.content ?? [])
    const method = entry.method ?? 0
    const compressed =
      method === 8 ? deflateRawSync(content) : Buffer.from(content)
    const crc = (entry.crc ?? crc32(content)) >>> 0
    const flags = entry.flags ?? 0x800
    const directory = entry.name.endsWith('/')
    const unixMode = entry.unixMode ?? (directory ? 0o040755 : 0o100644)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.byteLength, 18)
    local.writeUInt32LE(content.byteLength, 22)
    local.writeUInt16LE(name.byteLength, 26)
    localParts.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.byteLength, 20)
    central.writeUInt32LE(content.byteLength, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt16LE(directory ? 0x10 : 0, 36)
    central.writeUInt32LE(
      ((unixMode & 0xffff) * 0x10000 + (directory ? 0x10 : 0)) >>> 0,
      38,
    )
    central.writeUInt32LE(entry.localHeaderOffset ?? localOffset, 42)
    centralParts.push(central, name)

    localOffset += local.byteLength + name.byteLength + compressed.byteLength
  }

  const centralOffset = localOffset
  const centralSize = centralParts.reduce((size, part) => size + part.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([...localParts, ...centralParts, eocd])
}

export function crc32(content: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of content) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
