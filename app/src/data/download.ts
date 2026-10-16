import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import { USER_AGENT } from '../wporg/http.js'
import { DataError, manifestUrl, parseManifest, type Manifest } from './manifest.js'

// The network half of rules fetch and tm fetch. Everything polyglots-data
// serves is checked against a size and, for files, a sha512 the manifest
// names, so a wrong or hostile file is refused before anything reads it.
//
// The WP-CLI phar download in src/lint/make-pot.ts hashes in memory, which is
// right for a fixed 7 MB file. A TM is tens of MiB and has a ceiling of 200,
// and its size comes from a manifest rather than a pin, so this one streams to
// disk, hashing and counting as it goes, and stops the moment the count
// passes what the manifest promised.

// A download is cut off when no byte has arrived for this long, rather than
// after a fixed total: a 40 MiB TM on a slow line can rightly take minutes,
// and a connection that has gone quiet for half a minute is not coming back.
const STALL_MS = 30_000

const tooLarge = (url: string, maxBytes: number) => new DataError(`${url} is larger than ${maxBytes} bytes; nothing was written`)

/** A timer that aborts the request, restarted by every chunk that arrives. */
function watchdog(ms: number) {
  const controller = new AbortController()
  let fired = false
  let timer: NodeJS.Timeout | undefined
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      fired = true
      controller.abort()
    }, ms)
  }
  arm()
  return { signal: controller.signal, arm, fired: () => fired, stop: () => clearTimeout(timer) }
}

// One GET, redirects followed (GitHub sends every release asset through
// objects.githubusercontent.com, contract point 3, and nobody pins the host),
// with the User-Agent every other polyglots request carries. A transport
// failure becomes a DataError, so the CLI prints one line rather than
// undici's "fetch failed".
async function get(url: string, accept: string, maxBytes: number, signal: AbortSignal): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept }, redirect: 'follow', signal })
  } catch (err) {
    if (signal.aborted) throw err
    throw new DataError(`GET ${url} failed: ${reason(err)}`)
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    throw new DataError(`GET ${url} failed: ${res.status}`)
  }
  // A declared length over the limit is refused before the body is read; the
  // count below still holds a server that declares nothing, or lies.
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined)
    throw tooLarge(url, maxBytes)
  }
  return res
}

// undici puts the useful part (ECONNREFUSED, ENOTFOUND) in the cause.
function reason(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = err.cause
  if (cause instanceof Error && cause.message) return cause.message
  return err.message
}

const PARTIAL_PREFIX = '.polyglots-data-'
const PARTIAL_MAX_AGE_MS = 24 * 60 * 60 * 1000

// download's catch removes its file on every refusal, but a Ctrl-C ends the
// process before the catch runs, and tm fetch downloads into the data folder,
// where a hidden partial TM of tens of MiB would then stay for good. Nothing
// records which downloads are in flight, and a second polyglots may be in the
// middle of one in the same folder, so age is the only safe test: a file
// nobody has written to for a day is no live download's. Best effort
// throughout; a folder that cannot be listed is no reason to refuse a fetch.
async function removeAbandoned(dir: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  const cutoff = Date.now() - PARTIAL_MAX_AGE_MS
  for (const name of names) {
    if (!name.startsWith(PARTIAL_PREFIX)) continue
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (info.isFile() && info.mtimeMs < cutoff) await rm(path, { force: true })
    } catch {
      // Gone already, or not ours to read: either way, not this fetch's concern.
    }
  }
}

/**
 * Streams `url` into a new file in `dir`, hashing as it goes, and returns the
 * file's path once its sha512 matches. Any refusal (a failed request, more
 * than `maxBytes`, a stall, a hash mismatch) removes the file first, so a
 * caller that catches the error has nothing to clean up. The caller moves or
 * deletes the file it is given.
 */
export async function download(
  url: string,
  // stallMs exists for the tests, which cannot wait out half a minute to see a
  // stall; every caller in the app leaves it to STALL_MS.
  opts: { maxBytes: number; sha512: string; dir: string; stallMs?: number },
): Promise<string> {
  const { maxBytes, dir, stallMs = STALL_MS } = opts
  const expected = opts.sha512.toLowerCase()
  // A name of its own per download, so two runs at once never share a file,
  // and a leading dot, so a folder listing does not show a half-written one.
  await removeAbandoned(dir)
  const path = join(dir, `${PARTIAL_PREFIX}${randomUUID()}`)
  const dog = watchdog(stallMs)
  try {
    const res = await get(url, 'application/octet-stream', maxBytes, dog.signal)
    if (!res.body) throw new DataError(`GET ${url} answered with no body`)
    await mkdir(dir, { recursive: true })
    const hash = createHash('sha512')
    let received = 0
    await pipeline(
      Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          received += chunk.length
          if (received > maxBytes) throw tooLarge(url, maxBytes)
          hash.update(chunk)
          dog.arm()
          yield chunk
        }
      },
      createWriteStream(path, { flags: 'wx' }),
    )
    if (hash.digest('hex') !== expected) {
      throw new DataError(`${url} does not match the sha512 in the manifest; nothing was written`)
    }
    return path
  } catch (err) {
    await rm(path, { force: true }).catch(() => undefined)
    if (err instanceof DataError) throw err
    if (dog.fired()) throw new DataError(`GET ${url} stalled: nothing arrived for ${stallMs / 1000} s; nothing was written`)
    throw new DataError(`GET ${url} failed: ${reason(err)}`)
  } finally {
    dog.stop()
  }
}

/**
 * GETs `url` and parses it as JSON, refusing past `maxBytes` and after
 * `timeoutMs` in all, body included: the manifest is a few kB, and a client
 * waiting longer than the timeout for it is waiting on a server that has
 * gone.
 */
export async function fetchJson(url: string, opts: { maxBytes: number; timeoutMs: number }): Promise<unknown> {
  const { maxBytes, timeoutMs } = opts
  const dog = watchdog(timeoutMs)
  try {
    const res = await get(url, 'application/json', maxBytes, dog.signal)
    const chunks: Uint8Array[] = []
    let received = 0
    if (res.body) {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.length
        if (received > maxBytes) {
          await reader.cancel().catch(() => undefined)
          throw new DataError(`${url} is larger than ${maxBytes} bytes`)
        }
        chunks.push(value)
      }
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch {
      throw new DataError(`${url} did not answer with JSON`)
    }
  } catch (err) {
    if (err instanceof DataError) throw err
    if (dog.fired()) throw new DataError(`GET ${url} timed out after ${timeoutMs} ms`)
    throw new DataError(`GET ${url} failed: ${reason(err)}`)
  } finally {
    dog.stop()
  }
}

const MANIFEST_MAX_BYTES = 1 << 20
const MANIFEST_TIMEOUT_MS = 15_000

/**
 * The network, as the CLI and TUI see it: one CliDeps member, so tests and
 * the website demos replace it whole and nothing they run reaches GitHub.
 */
export interface DataClient {
  manifest(): Promise<Manifest>
  download: typeof download
}

export const dataClient: DataClient = {
  manifest: async () => parseManifest(await fetchJson(manifestUrl(), { maxBytes: MANIFEST_MAX_BYTES, timeoutMs: MANIFEST_TIMEOUT_MS })),
  download,
}
