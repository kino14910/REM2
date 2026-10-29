import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isSha256,
  parseSha256Text,
  sha256File,
  verifyFileDigest,
} from '../../src/host/plugins/integrity.js'

const ABC_SHA256 =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

describe('unit · release integrity', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-integrity-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('accepts exactly 64 hexadecimal characters without regard to case', () => {
    expect(isSha256(ABC_SHA256)).toBe(true)
    expect(isSha256(ABC_SHA256.toUpperCase())).toBe(true)
  })

  it.each([
    ['too short', ABC_SHA256.slice(1)],
    ['not hexadecimal', `${'g'.repeat(64)}`],
    ['not a string', 42],
    ['null', null],
  ])('rejects an invalid digest (%s)', (_label, value) => {
    expect(isSha256(value)).toBe(false)
  })

  it.each([
    ['plain digest', ABC_SHA256],
    ['digest and filename', `${ABC_SHA256}  plugin.zip`],
    ['binary checksum line', `${ABC_SHA256} *plugin.zip`],
    ['BSD checksum line', `SHA256 (plugin.zip) = ${ABC_SHA256}`],
    ['surrounding whitespace', `  ${ABC_SHA256}  `],
  ])('parses %s', (_label, text) => {
    expect(parseSha256Text(text)).toBe(ABC_SHA256)
  })

  it('uses the first valid line and normalizes letter case', () => {
    expect(
      parseSha256Text(
        `\nnot a checksum\n${ABC_SHA256.toUpperCase()}  first.zip\n${'0'.repeat(64)}`,
      ),
    ).toBe(ABC_SHA256)
  })

  it.each([
    ['empty text', ''],
    ['invalid BSD digest', 'SHA256 (plugin.zip) = nope'],
    ['unrelated text', 'release checksum unavailable'],
  ])('returns undefined for unsupported checksum text (%s)', (_label, text) => {
    expect(parseSha256Text(text)).toBeUndefined()
  })

  it('hashes a file using a known SHA-256 vector', async () => {
    const file = path.join(root, 'abc.txt')
    await writeFile(file, 'abc')
    expect(await sha256File(file)).toBe(ABC_SHA256)
  })

  it('accepts a matching digest with uppercase hexadecimal', async () => {
    const file = path.join(root, 'abc.txt')
    await writeFile(file, 'abc')
    await expect(
      verifyFileDigest(file, ABC_SHA256.toUpperCase()),
    ).resolves.toBeUndefined()
  })

  it('reports both expected and actual digests on mismatch', async () => {
    const file = path.join(root, 'abc.txt')
    await writeFile(file, 'abc')
    const expected = '0'.repeat(64)
    await expect(verifyFileDigest(file, expected)).rejects.toMatchObject({
      code: 'E_DIGEST_MISMATCH',
      message: expect.stringContaining(`expected ${expected}`),
    })
    await expect(verifyFileDigest(file, expected)).rejects.toMatchObject({
      message: expect.stringContaining(`actual ${ABC_SHA256}`),
    })
  })

  it('rejects an invalid expected digest before reading the file', async () => {
    await expect(
      verifyFileDigest(path.join(root, 'missing.zip'), 'not-a-sha256'),
    ).rejects.toMatchObject({ code: 'E_DIGEST_INVALID' })
  })
})
