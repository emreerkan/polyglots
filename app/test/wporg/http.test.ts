import { afterEach, describe, expect, it, vi } from 'vitest'
import { httpGet, USER_AGENT } from '../../src/wporg/http.js'
import { VERSION } from '../../src/version.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

const respond = (status: number, body: string) =>
  vi.fn(async () => new Response(body, { status }))

/**
 * Resolution has to tell "this project does not exist" from "wp.org did not
 * answer". fetchHtml throws the same error for both, which would report a real
 * project as missing during an outage, so this one returns the status.
 */
describe('httpGet', () => {
  it('returns a 404 as a status, not an error', async () => {
    vi.stubGlobal('fetch', respond(404, 'not here'))
    expect(await httpGet('https://example.test/missing')).toEqual({ status: 404, body: 'not here' })
  })

  it('returns the body of a successful request', async () => {
    vi.stubGlobal('fetch', respond(200, '<table></table>'))
    expect(await httpGet('https://example.test/page')).toEqual({ status: 200, body: '<table></table>' })
  })

  // A server error is a status too: the caller decides it means unreachable.
  it('returns a server error as a status', async () => {
    vi.stubGlobal('fetch', respond(503, 'busy'))
    expect((await httpGet('https://example.test/page')).status).toBe(503)
  })

  // wp.org says how long to back off on a 429; the caller needs it to wait
  // that long rather than guess.
  it('passes on a Retry-After header with the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '30' } })))
    expect(await httpGet('https://example.test/page')).toEqual({ status: 429, body: 'slow down', retryAfter: '30' })
  })

  it('names the URL when it gives up waiting', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
          }),
      ),
    )
    await expect(httpGet('https://example.test/slow', { timeoutMs: 10 })).rejects.toThrow(/example\.test\/slow.*timed out/)
  })

  // A caller leaving the screen cancels the request. That is not a timeout,
  // and reporting it as one would name a slow server that was never slow.
  it("cancels the request on the caller's signal, as an abort", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
          }),
      ),
    )
    const controller = new AbortController()
    const request = httpGet('https://example.test/slow', { signal: controller.signal })
    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('identifies itself with the version actually running', async () => {
    const seen = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      expect(init.headers['User-Agent']).toBe(USER_AGENT)
      return new Response('', { status: 200 })
    })
    vi.stubGlobal('fetch', seen)
    await httpGet('https://example.test/')
    expect(USER_AGENT).toContain(VERSION)
  })
})
