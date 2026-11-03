import { describe, expect, it, vi } from 'vitest'

import { resolveRemoteRelease } from '@/host/plugins/release-source.js'

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

function streamedResponse(
  chunks: Uint8Array[],
  headers = new Headers(),
): Response {
  const body = (async function* () {
    for (const chunk of chunks) yield chunk
  })()
  return { ok: true, status: 200, headers, body } as unknown as Response
}

function fetchReleaseAndSidecar(
  sidecar: () => Response | Promise<Response>,
): typeof fetch {
  return vi.fn<typeof fetch>(async input => {
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
    return sidecar()
  })
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

  it('rejects a release metadata redirect outside the HTTPS allowlist', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://evil.test/releases/latest' },
      })
    })
    await expect(
      resolveRemoteRelease(
        'https://github.com/example/plugin/releases/latest',
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'E_SOURCE_INVALID' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('follows an allowlisted metadata redirect and validates the hop', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      if (String(input).includes('/releases/latest')) {
        return new Response(null, {
          status: 302,
          headers: {
            location:
              'https://objects.githubusercontent.com/release-metadata.json',
          },
        })
      }
      return jsonResponse(
        releaseWith([zipAsset({ digest: `sha256:${digest}` })]),
      )
    })

    const release = await resolveRemoteRelease(
      'https://github.com/example/plugin/releases/latest',
      { fetchImpl },
    )
    expect(release.sha256).toBe(digest)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ redirect: 'manual' })
  })

  it('rejects a non-GitHub HTTPS zip before fetching', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(
      resolveRemoteRelease('https://cdn.example.com/plugin-v3.4.5.zip', {
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'E_SOURCE_INVALID' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('accepts an allowlisted direct asset and infers its version', async () => {
    const source = 'https://objects.githubusercontent.com/plugin-v3.4.5.zip'
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
      'https://objects.githubusercontent.com/plugin.zip',
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

  it('rejects release metadata with an oversized Content-Length', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      streamedResponse(
        [new Uint8Array(1)],
        new Headers({ 'content-length': String(1024 * 1024 + 1) }),
      ),
    )
    await expect(
      resolveRemoteRelease(
        'https://github.com/example/plugin/releases/latest',
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      code: 'E_DOWNLOAD',
      message: expect.stringContaining('byte limit'),
    })
  })

  it('rejects release metadata that exceeds the limit while streaming', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      streamedResponse([new Uint8Array(1024 * 1024 + 1)]),
    )
    await expect(
      resolveRemoteRelease(
        'https://github.com/example/plugin/releases/latest',
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      code: 'E_DOWNLOAD',
      message: expect.stringContaining('while streaming'),
    })
  })

  it('propagates sidecar HTTP errors instead of omitting the digest', async () => {
    const fetchImpl = fetchReleaseAndSidecar(() => jsonResponse({}, 500))
    await expect(
      resolveRemoteRelease(
        'https://github.com/example/plugin/releases/tag/v1.2.3',
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'E_DOWNLOAD' })
  })

  it('propagates sidecar network errors instead of omitting the digest', async () => {
    const fetchImpl = fetchReleaseAndSidecar(async () => {
      throw new Error('connection lost')
    })
    await expect(
      resolveRemoteRelease(
        'https://github.com/example/plugin/releases/tag/v1.2.3',
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      code: 'E_DOWNLOAD',
      cause: expect.objectContaining({ message: 'connection lost' }),
    })
  })

  it('leaves sha256 undefined when the sidecar digest is invalid', async () => {
    const fetchImpl = fetchReleaseAndSidecar(
      () => new Response('not a sha256 digest', { status: 200 }),
    )
    const release = await resolveRemoteRelease(
      'https://github.com/example/plugin/releases/tag/v1.2.3',
      { fetchImpl },
    )
    expect(release.sha256).toBeUndefined()
  })

  it.each([
    [
      'Content-Length',
      () =>
        streamedResponse(
          [new Uint8Array(1)],
          new Headers({ 'content-length': String(16 * 1024 + 1) }),
        ),
    ],
    ['streamed body', () => streamedResponse([new Uint8Array(16 * 1024 + 1)])],
  ])('rejects an oversized sidecar %s', async (_label, sidecar) => {
    const fetchImpl = fetchReleaseAndSidecar(sidecar)
    await expect(
      resolveRemoteRelease(
        'https://github.com/example/plugin/releases/tag/v1.2.3',
        { fetchImpl },
      ),
    ).rejects.toMatchObject({
      code: 'E_DOWNLOAD',
      message: expect.stringContaining('byte limit'),
    })
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
