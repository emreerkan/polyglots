import { VERSION } from '../version.js'

// The version actually running, rather than the 0.1 this was written at: a
// server operator reading their logs should be able to tell builds apart. The
// link is the one place that operator can find who to contact, so it names the
// real repository rather than an account that does not hold it.
export const USER_AGENT = `polyglots/${VERSION} (+https://github.com/emreerkan/polyglots)`
const TIMEOUT_MS = 20_000

// The Accept header is the caller's: a page asks for HTML, the glossary export
// for CSV. wp.org serves either way today, but saying what is wanted costs
// nothing and keeps a content-negotiating proxy from guessing.
export async function fetchHtml(url: string, accept = 'text/html'): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`)
    }
    return await res.text()
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`GET ${url} timed out after ${TIMEOUT_MS}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export interface HttpResponse {
  status: number
  body: string
  // The Retry-After header, raw, when the server sent one. wp.org sends it with
  // a 429, and the caller waits that long rather than guessing.
  retryAfter?: string
}

export type HttpGet = (url: string, opts?: { timeoutMs?: number }) => Promise<HttpResponse>

/**
 * A GET that reports the status instead of throwing on it.
 *
 * `fetchHtml` throws the same error for a 404 as for a server that did not
 * answer, which is right for a scraper that wants a page or nothing. Resolving
 * a project list needs the difference: a 404 means the project does not exist,
 * and anything else means wp.org could not be asked, which must never be
 * reported as a missing project.
 *
 * The timeout is the caller's. A page answers in a second or two; an export of
 * a project the size of WooCommerce, over 14,000 strings, takes far longer than
 * the twenty seconds a scraped page is given.
 */
export const httpGet: HttpGet = async (url, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    })
    const retryAfter = res.headers.get('retry-after')
    return { status: res.status, body: await res.text(), ...(retryAfter ? { retryAfter } : {}) }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`GET ${url} timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
