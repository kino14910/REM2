import { describe, expect, it } from 'vitest'

import {
  RegistryClientError,
  type RegistryClientErrorCode,
} from '@/host/registry/errors.js'
import {
  parseRegistryIndex,
  parseRegistryIndexJson,
} from '@/host/registry/parser.js'

import {
  makeRegistryIndex,
  makeRegistryPlugin,
  makeRegistryVersion,
} from '../helpers/registry-index.js'

function registryError(action: () => unknown): RegistryClientError {
  try {
    action()
  } catch (error) {
    if (error instanceof RegistryClientError) return error
    throw error
  }
  throw new Error('expected a RegistryClientError')
}

function expectCode(
  error: RegistryClientError,
  code: RegistryClientErrorCode,
): void {
  expect(error.code).toBe(code)
}

describe('unit · registry parser', () => {
  it('accepts a schema v1 index and strips unknown fields', () => {
    const version = makeRegistryVersion()
    const raw: unknown = {
      ...makeRegistryIndex(),
      futureTopLevel: 'ignored',
      plugins: [
        {
          ...makeRegistryPlugin(),
          futurePlugin: 'ignored',
          versions: [
            {
              ...version,
              compatibility: {
                ...version.compatibility,
                futureCompatibility: 'ignored',
              },
              futureVersion: 'ignored',
            },
          ],
        },
      ],
    }

    expect(parseRegistryIndex(raw)).toEqual(
      makeRegistryIndex({
        plugins: [makeRegistryPlugin({ versions: [version] })],
      }),
    )
  })

  it('keeps optional homepage and icon fields', () => {
    const plugin = makeRegistryPlugin({
      homepage: 'https://github.com/kino14910/REM2-plugins',
      icon: 'icon.png',
    })
    expect(
      parseRegistryIndex(makeRegistryIndex({ plugins: [plugin] })).plugins[0],
    ).toEqual(plugin)
  })

  it('parses JSON text', () => {
    const index = makeRegistryIndex()
    expect(parseRegistryIndexJson(JSON.stringify(index))).toEqual(index)
  })

  it('reports JSON syntax errors separately from schema errors', () => {
    const error = registryError(() =>
      parseRegistryIndexJson('{"schemaVersion":1'),
    )
    expectCode(error, 'E_REGISTRY_PARSE')
  })

  it('rejects unsupported schema versions instead of guessing', () => {
    const error = registryError(() =>
      parseRegistryIndex({ ...makeRegistryIndex(), schemaVersion: 2 }),
    )
    expectCode(error, 'E_REGISTRY_SCHEMA_VERSION')
    expect(error.message).toContain('unsupported registry schemaVersion: 2')
  })

  it('rejects non-object indexes', () => {
    expectCode(
      registryError(() => parseRegistryIndex(null)),
      'E_REGISTRY_SCHEMA',
    )
  })

  const invalidIndexes: Array<[string, () => unknown]> = [
    [
      'invalid plugin id',
      () =>
        makeRegistryIndex({
          plugins: [makeRegistryPlugin({ id: 'Theme.Switcher' })],
        }),
    ],
    [
      'duplicate plugin id',
      () =>
        makeRegistryIndex({
          plugins: [makeRegistryPlugin(), makeRegistryPlugin()],
        }),
    ],
    [
      'duplicate tags',
      () =>
        makeRegistryIndex({
          plugins: [makeRegistryPlugin({ tags: ['ui', 'ui'] })],
        }),
    ],
    [
      'invalid tags',
      () =>
        makeRegistryIndex({
          plugins: [makeRegistryPlugin({ tags: ['', 'ui'] })],
        }),
    ],
    [
      'missing versions',
      () =>
        makeRegistryIndex({ plugins: [makeRegistryPlugin({ versions: [] })] }),
    ],
    [
      'versions sorted ascending',
      () =>
        makeRegistryIndex({
          plugins: [
            makeRegistryPlugin({
              versions: [
                makeRegistryVersion({ version: '0.9.0' }),
                makeRegistryVersion(),
              ],
            }),
          ],
        }),
    ],
    [
      'tag does not match the version',
      () =>
        makeRegistryIndex({
          plugins: [
            makeRegistryPlugin({
              versions: [makeRegistryVersion({ tag: 'theme-switcher-v2.0.0' })],
            }),
          ],
        }),
    ],
    [
      'asset name does not match the version',
      () =>
        makeRegistryIndex({
          plugins: [
            makeRegistryPlugin({
              versions: [
                makeRegistryVersion({ assetName: 'theme-switcher-2.0.0.zip' }),
              ],
            }),
          ],
        }),
    ],
    [
      'download URL uses another host',
      () =>
        makeRegistryIndex({
          plugins: [
            makeRegistryPlugin({
              versions: [
                makeRegistryVersion({
                  downloadUrl: 'https://example.com/theme-switcher-1.0.0.zip',
                }),
              ],
            }),
          ],
        }),
    ],
    [
      'download URL uses another repository',
      () =>
        makeRegistryIndex({
          plugins: [
            makeRegistryPlugin({
              versions: [
                makeRegistryVersion({
                  downloadUrl:
                    'https://github.com/other/REM2-plugins/releases/download/theme-switcher-v1.0.0/theme-switcher-1.0.0.zip',
                }),
              ],
            }),
          ],
        }),
    ],
    [
      'download URL uses another tag',
      () =>
        makeRegistryIndex({
          plugins: [
            makeRegistryPlugin({
              versions: [
                makeRegistryVersion({
                  downloadUrl:
                    'https://github.com/kino14910/REM2-plugins/releases/download/theme-switcher-v2.0.0/theme-switcher-1.0.0.zip',
                }),
              ],
            }),
          ],
        }),
    ],
    [
      'uppercase sha256',
      () =>
        makeRegistryIndex({
          plugins: [
            makeRegistryPlugin({
              versions: [makeRegistryVersion({ sha256: 'A'.repeat(64) })],
            }),
          ],
        }),
    ],
    [
      'short sha256',
      () =>
        makeRegistryIndex({
          plugins: [
            makeRegistryPlugin({
              versions: [makeRegistryVersion({ sha256: 'a'.repeat(63) })],
            }),
          ],
        }),
    ],
    [
      'non-positive size',
      () =>
        makeRegistryIndex({
          plugins: [
            makeRegistryPlugin({
              versions: [makeRegistryVersion({ sizeBytes: 0 })],
            }),
          ],
        }),
    ],
    [
      'invalid maxKernel',
      () =>
        makeRegistryIndex({
          plugins: [
            makeRegistryPlugin({
              versions: [
                makeRegistryVersion({
                  compatibility: {
                    minKernel: '^1.0.0',
                    maxKernel: '^2.0.0',
                    contractVersion: '1',
                  },
                }),
              ],
            }),
          ],
        }),
    ],
    [
      'invalid minKernel',
      () =>
        makeRegistryIndex({
          plugins: [
            makeRegistryPlugin({
              versions: [
                makeRegistryVersion({
                  compatibility: {
                    minKernel: 'not a range',
                    contractVersion: '1',
                  },
                }),
              ],
            }),
          ],
        }),
    ],
    [
      'duplicate capabilities',
      () =>
        makeRegistryIndex({
          plugins: [
            makeRegistryPlugin({
              versions: [
                makeRegistryVersion({ requires: ['ui.theme', 'ui.theme'] }),
              ],
            }),
          ],
        }),
    ],
    [
      'invalid capability name',
      () =>
        makeRegistryIndex({
          plugins: [
            makeRegistryPlugin({
              versions: [makeRegistryVersion({ requires: ['UI Theme'] })],
            }),
          ],
        }),
    ],
    [
      'invalid generatedAt',
      () => makeRegistryIndex({ generatedAt: 'yesterday' }),
    ],
    [
      'invalid repository',
      () =>
        makeRegistryIndex({ repository: 'https://gitlab.com/rem2/plugins' }),
    ],
  ]

  it.each(invalidIndexes)('rejects %s', (_label, build) => {
    expectCode(
      registryError(() => parseRegistryIndex(build())),
      'E_REGISTRY_SCHEMA',
    )
  })
})
