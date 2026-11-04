import type {
  RegistryCompatibilityDeclaration,
  RegistryIndex,
  RegistryPlugin,
  RegistryVersion,
} from '@/host/registry/types.js'

const REPOSITORY = 'https://github.com/kino14910/REM2-plugins'
const DIGEST =
  '4f2e45d7e41b2bab5bdfecac3d2421fc59b035d5fdc97b412e7c028a1b40d365'

export type RegistryVersionOptions = Omit<
  Partial<RegistryVersion>,
  'compatibility' | 'tag' | 'assetName' | 'downloadUrl'
> & {
  compatibility?: Partial<RegistryCompatibilityDeclaration>
  tag?: string
  assetName?: string
  downloadUrl?: string
  directory?: string
}

export function makeRegistryVersion(
  options: RegistryVersionOptions = {},
): RegistryVersion {
  const version = options.version ?? '1.0.0'
  const directory = options.directory ?? 'theme-switcher'
  const tag = options.tag ?? `${directory}-v${version}`
  const assetName = options.assetName ?? `${directory}-${version}.zip`
  return {
    version,
    tag,
    publishedAt: options.publishedAt ?? '2026-10-31T03:53:49.000Z',
    assetName,
    downloadUrl:
      options.downloadUrl ??
      `https://github.com/kino14910/REM2-plugins/releases/download/${tag}/${assetName}`,
    sha256: options.sha256 ?? DIGEST,
    sizeBytes: options.sizeBytes ?? 5554,
    compatibility: {
      minKernel: '^1.0.0',
      contractVersion: '1',
      ...options.compatibility,
    },
    requires: options.requires ?? ['ui.theme', 'ui.panel', 'ui.route'],
  }
}

export type RegistryPluginOptions = Omit<
  Partial<RegistryPlugin>,
  'versions'
> & {
  versions?: RegistryVersion[]
}

export function makeRegistryPlugin(
  options: RegistryPluginOptions = {},
): RegistryPlugin {
  return {
    id: options.id ?? 'com.rem2.theme-switcher',
    name: options.name ?? 'Theme Switcher',
    description:
      options.description ??
      'Light/dark/system theme catalog plus a form panel for mode and accent preferences',
    author: options.author ?? 'rem2-plugins',
    tags: options.tags ?? ['ui', 'theme', 'settings'],
    versions: options.versions ?? [makeRegistryVersion()],
    ...(options.homepage === undefined ? {} : { homepage: options.homepage }),
    ...(options.icon === undefined ? {} : { icon: options.icon }),
  }
}

export type RegistryIndexOptions = Omit<Partial<RegistryIndex>, 'plugins'> & {
  plugins?: RegistryPlugin[]
}

export function makeRegistryIndex(
  options: RegistryIndexOptions = {},
): RegistryIndex {
  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? '2026-11-04T06:25:44.202Z',
    repository: options.repository ?? REPOSITORY,
    plugins: options.plugins ?? [makeRegistryPlugin()],
  }
}

export { DIGEST, REPOSITORY }
