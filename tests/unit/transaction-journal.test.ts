import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PluginUpdateJournal,
  type UpdateTransactionRecord,
} from '../../src/host/plugins/transaction-journal.js'
import type { PluginProvenance } from '../../src/host/plugins/provenance-store.js'

const nextProvenance: PluginProvenance = {
  kind: 'remote',
  url: 'https://github.com/example/plugin/releases/download/v2.0.0/plugin.zip',
  sha256: 'b'.repeat(64),
  publishedAt: '2026-02-02T03:04:05Z',
  installedAt: '2026-02-03T03:04:05Z',
}

const previousProvenance: PluginProvenance = {
  kind: 'remote',
  url: 'https://github.com/example/plugin/releases/download/v1.0.0/plugin.zip',
  sha256: 'a'.repeat(64),
  installedAt: '2026-01-03T03:04:05Z',
}

function validRecord(
  overrides: Partial<UpdateTransactionRecord> = {},
): UpdateTransactionRecord {
  return {
    version: 1,
    pluginId: 'com.example.plugin',
    stage: 'prepared',
    backupName: '.backup-com.example.plugin-1700000000000',
    workName: '.update-com.example.plugin-1700000000000',
    previousDisabled: true,
    previousProvenance,
    nextProvenance,
    ...overrides,
  }
}

describe('unit · plugin update journal', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  async function journal(): Promise<{
    dir: string
    store: PluginUpdateJournal
  }> {
    root = await mkdtemp(path.join(tmpdir(), 'rem2-journal-'))
    const dir = path.join(root, 'plugin-transactions')
    return { dir, store: new PluginUpdateJournal(dir) }
  }

  it('treats a missing directory as an empty journal', async () => {
    const { store } = await journal()
    await expect(store.list()).resolves.toEqual([])
  })

  it('round-trips a record through a fresh instance', async () => {
    const { dir, store } = await journal()
    await store.record(validRecord({ stage: 'installed' }))

    const reloaded = new PluginUpdateJournal(dir)
    await expect(reloaded.list()).resolves.toEqual([
      validRecord({ stage: 'installed' }),
    ])
  })

  it('persists one file per plugin and overwrites in place', async () => {
    const { dir, store } = await journal()
    await store.record(validRecord())
    await store.record(validRecord({ stage: 'backed-up' }))
    await store.record(
      validRecord({ pluginId: 'com.example.other', stage: 'prepared' }),
    )

    const entries = (await readdir(dir)).toSorted()
    expect(entries).toEqual([
      'com.example.other.json',
      'com.example.plugin.json',
    ])
    expect(
      JSON.parse(
        await readFile(path.join(dir, 'com.example.plugin.json'), 'utf8'),
      ),
    ).toEqual(validRecord({ stage: 'backed-up' }))
  })

  it('leaves no temporary files behind on success', async () => {
    const { dir, store } = await journal()
    await store.record(validRecord())
    const entries = await readdir(dir)
    expect(entries.filter(entry => entry.endsWith('.tmp'))).toEqual([])
  })

  it('clears records idempotently and validates the plugin id', async () => {
    const { store } = await journal()
    await store.record(validRecord())
    await store.clear('com.example.plugin')
    await store.clear('com.example.plugin')
    await expect(store.list()).resolves.toEqual([])
    await expect(store.clear('../escape')).rejects.toThrow(/invalid plugin id/)
  })

  it('skips non-json and corrupt entries instead of failing startup', async () => {
    const { dir, store } = await journal()
    await mkdir(dir, { recursive: true })
    await store.record(validRecord({ pluginId: 'com.example.good' }))
    await writeFile(
      path.join(dir, '.com.example.plugin-1.tmp'),
      '{"partial":',
      'utf8',
    )
    await writeFile(
      path.join(dir, 'com.example.broken.json'),
      '{"version":1',
      'utf8',
    )
    await writeFile(
      path.join(dir, 'com.example.wrongstage.json'),
      JSON.stringify(validRecord({ stage: 'nope' as never })),
      'utf8',
    )
    await writeFile(
      path.join(dir, 'com.example.escape.json'),
      JSON.stringify(validRecord({ backupName: '../escape' })),
      'utf8',
    )

    await expect(store.list()).resolves.toEqual([
      validRecord({ pluginId: 'com.example.good' }),
    ])
  })

  it('rejects invalid records before touching the filesystem', async () => {
    const { dir, store } = await journal()

    const invalid: Array<[string, UpdateTransactionRecord]> = [
      ['path traversal id', validRecord({ pluginId: '../escape' })],
      ['unsupported version', validRecord({ version: 2 as never })],
      ['unknown stage', validRecord({ stage: 'unknown' as never })],
      ['backup outside tree', validRecord({ backupName: '../backup' })],
      ['work outside tree', validRecord({ workName: '/tmp/update' })],
      [
        'missing disabled flag',
        validRecord({ previousDisabled: 'yes' as never }),
      ],
      [
        'insecure provenance url',
        validRecord({
          nextProvenance: {
            ...nextProvenance,
            url: 'http://example.com/p.zip',
          },
        }),
      ],
      [
        'malformed digest',
        validRecord({
          nextProvenance: { ...nextProvenance, sha256: 'not-a-digest' },
        }),
      ],
      [
        'invalid previous provenance',
        validRecord({
          previousProvenance: { ...previousProvenance, kind: 'local' as never },
        }),
      ],
    ]

    for (const [label, record] of invalid) {
      await expect(store.record(record), label).rejects.toThrow(
        /invalid update journal/,
      )
    }
    await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows a record without previous provenance', async () => {
    const { store } = await journal()
    const record = validRecord()
    delete record.previousProvenance
    await store.record(record)
    const [stored] = await store.list()
    expect(stored).toEqual(record)
    expect(stored?.previousProvenance).toBeUndefined()
  })
})
