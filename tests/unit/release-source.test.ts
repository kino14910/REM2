import { describe, expect, it, vi } from 'vitest'
import { resolveRemoteRelease } from '../../src/host/plugins/release-source.js'

const digest = 'a'.repeat(64)
const publishedAt = '2026-01-02T03:04:05Z'
const notes = 'Release notes'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function releaseWith(assets: unknown[], tag = 'v1.2.3'): unknown {
  return {
    tag_name: tag,
    published_at: publishedAt,
    body: notes,
    assets,
  }
}

function zipAsset(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'plugin.zip',
    browser_download_url:
      'https://github.com/example/plugin/releases/download/v1.2.3/plugin.zip',
    size: 1234,
    ...extra,
  }
}

describe('unit · remote release source', () => {
  it('resolves a download URL and reads its sidecar digest', async () => {
    const source =
      'https://github.com/example/plugin/releases/download/v1.2.3/plugin.zip'
    const sidecarUrl = `${source}.sha256`
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = String(input)
      if (
        url ===
        'https://api.github.com/repos/example/plugin/releases/tags/v1.2.3'
      ) {
        return jsonResponse(
          releaseWith([
            zipAsset(),
            {
              name: 'plugin.zip.sha256',
              browser_download_url: sidecarUrl,
            },
          ]),
        )
      }
      if (url === sidecarUrl) {
        return new Response(`${digest}  plugin.zip\n`, { status: 200 })
      }
      throw new Error(`unexpected URL: ${url}`)
    })

    await expect(resolveRemoteRelease(source, { fetchImpl })).resolves.toEqual({
      sourceUrl: source,
      downloadUrl: source,
      version: '1.2.3',
      publishedAt,
      notes,
      sha256: digest,
      size: 1234,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('prefers the asset digest without fetching a sidecar', async () => {
    const source =
      'https://github.com/example/plugin/releases/download/v1.2.3/plugin.zip'
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(releaseWith([zipAsset({ digest: `sha256:${digest}` })])),
    )

    const release = await resolveRemoteRelease(source, { fetchImpl })
    expect(release.sha256).toBe(digest)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('selects the only zip asset for a tag URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        releaseWith([
          {
            name: 'notes.txt',
            browser_download_url:
              'https://github.com/example/plugin/releases/download/v1.2.3/notes.txt',
          },
          zipAsset({ digest: `sha256:${digest}` }),
        ]),
      ),
    )

    const release = await resolveRemoteRelease(
      'https://github.com/example/plugin/releases/tag/v1.2.3',
      { fetchImpl },
    )
    expect(release).toMatchObject({
      downloadUrl:
        'https://github.com/example/plugin/releases/download/v1.2.3/plugin.zip',
      version: '1.2.3',
      publishedAt,
      notes,
      sha256: digest,
    })
  })

  it.each([
    ['no', []],
    [
      'multiple',
      [
        zipAsset(),
        {
          ...zipAsset(),
          name: 'other.zip',
          browser_download_url:
            'https://github.com/example/plugin/releases/download/v1.2.3/other.zip',
        },
      ],
    ],
  ])('rejects a tag release with %s zip assets', async (_label, assets) => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(releaseWith(assets)),
    )
    await expect(
      resolveRemoteRelease(
        'https://github.com/example/plugin/releases/tag/v1.2.3',
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'E_SOURCE_INVALID' })
  })

  it.each([
    'https://github.com/example/plugin',
    'https://github.com/example/plugin/releases/latest',
  ])('resolves the latest release for %s', async source => {
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      expect(String(input)).toBe(
        'https://api.github.com/repos/example/plugin/releases/latest',
      )
      return jsonResponse(releaseWith([zipAsset()], 'v2.0.0'))
    })
    const release = await resolveRemoteRelease(source, { fetchImpl })
    expect(release.version).toBe('2.0.0')
    expect(release.downloadUrl).toBe(zipAsset().browser_download_url)
  })

  it('accepts a non-GitHub HTTPS zip and infers its version', async () => {
    const source = 'https://cdn.example.com/plugin-v3.4.5.zip'
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(resolveRemoteRelease(source, { fetchImpl })).resolves.toEqual({
      sourceUrl: source,
      downloadUrl: source,
      version: '3.4.5',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns an empty version when a direct filename has no semver', async () => {
    const release = await resolveRemoteRelease(
      'https://cdn.example.com/plugin.zip',
    )
    expect(release.version).toBe('')
    expect(release.sha256).toBeUndefined()
  })

  it.each([
    'http://github.com/example/plugin/releases/tag/v1.2.3',
    'https://github.com.evil.test/example/plugin/releases/tag/v1.2.3',
  ])('rejects an invalid scheme or host: %s', async source => {
    await expect(resolveRemoteRelease(source)).rejects.toMatchObject({
      code: 'E_SOURCE_INVALID',
    })
  })

  it('maps a required GitHub API error response to E_DOWNLOAD', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ message: 'not found' }, 404),
    )
    await expect(
      resolveRemoteRelease(
        'https://github.com/example/plugin/releases/latest',
        {
          fetchImpl,
        },
      ),
    ).rejects.toMatchObject({ code: 'E_DOWNLOAD' })
  })

  it('leaves sha256 undefined when no trusted digest exists', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(releaseWith([zipAsset()])),
    )
    const release = await resolveRemoteRelease(
      'https://github.com/example/plugin/releases/tag/v1.2.3',
      { fetchImpl },
    )
    expect(release.sha256).toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('treats sidecar failures as missing digests', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      if (String(input).startsWith('https://api.github.com/')) {
        return jsonResponse(
          releaseWith([
            zipAsset(),
            {
              name: 'plugin.zip.sha256',
              browser_download_url:
                'https://github.com/example/plugin/releases/download/v1.2.3/plugin.zip.sha256',
            },
          ]),
        )
      }
      return jsonResponse({}, 500)
    })
    const release = await resolveRemoteRelease(
      'https://github.com/example/plugin/releases/tag/v1.2.3',
      { fetchImpl },
    )
    expect(release.sha256).toBeUndefined()
  })

  it('falls back to URL metadata when a download release API is unreachable', async () => {
    const source =
      'https://github.com/example/plugin/releases/download/v4.5.6/plugin.zip'
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('offline')
    })
    await expect(resolveRemoteRelease(source, { fetchImpl })).resolves.toEqual({
      sourceUrl: source,
      downloadUrl: source,
      version: '4.5.6',
    })
  })
})
