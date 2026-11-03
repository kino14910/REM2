import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('electron', () => ({ net: { request: electronMock.request } }))

import { createSessionFetch } from '@/host/electron/session-fetch.js'

class FakeRequest extends EventEmitter {
  abort = vi.fn()
  end = vi.fn()
  followRedirect = vi.fn()
}

describe('unit · Electron session fetch adapter', () => {
  it('returns the redirect response instead of following it in manual mode', async () => {
    const request = new FakeRequest()
    request.end.mockImplementation(() => {
      queueMicrotask(() => {
        request.emit('redirect', 302, 'GET', 'https://evil.test/pkg.zip', {})
      })
    })
    electronMock.request.mockReturnValue(request)
    const fetchImpl = createSessionFetch({} as never)

    const response = await fetchImpl('https://github.com/a/b', {
      redirect: 'manual',
    })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://evil.test/pkg.zip')
    expect(request.abort).toHaveBeenCalled()
  })

  it('projects an Electron response body into a web Response', async () => {
    const request = new FakeRequest()
    request.end.mockImplementation(() => {
      queueMicrotask(() => {
        const response = Object.assign(new EventEmitter(), {
          statusCode: 200,
          headers: { 'content-type': ['text/plain'] },
        })
        request.emit('response', response)
        response.emit('data', Buffer.from('hello'))
        response.emit('end')
      })
    })
    electronMock.request.mockReturnValue(request)
    const fetchImpl = createSessionFetch({} as never)

    const response = await fetchImpl('https://api.github.com/repos/a/b')

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello')
    expect(response.headers.get('content-type')).toBe('text/plain')
  })
})
