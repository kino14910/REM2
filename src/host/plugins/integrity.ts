import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { PluginManagementError } from './errors.js'

const SHA256_PATTERN = /^[a-f\d]{64}$/i

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

export function parseSha256Text(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const bsd = /^SHA256\s*\([^)]*\)\s*=\s*([a-f\d]{64})$/i.exec(trimmed)
    if (bsd) return bsd[1].toLowerCase()

    const digestWithOptionalName =
      /^([a-f\d]{64})(?:[\t ]+\*?\S[\t \S]*)?$/i.exec(trimmed)
    if (digestWithOptionalName) return digestWithOptionalName[1].toLowerCase()
  }
  return undefined
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

export async function verifyFileDigest(
  filePath: string,
  expectedHex: string,
): Promise<void> {
  if (!isSha256(expectedHex)) {
    throw new PluginManagementError(
      'E_DIGEST_INVALID',
      'expected SHA-256 digest must contain exactly 64 hexadecimal characters',
    )
  }
  const actual = await sha256File(filePath)
  const expected = expectedHex.toLowerCase()
  if (actual !== expected) {
    throw new PluginManagementError(
      'E_DIGEST_MISMATCH',
      `SHA-256 digest mismatch: expected ${expected}, actual ${actual}`,
    )
  }
}
