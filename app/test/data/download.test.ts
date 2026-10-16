import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dataClient, download, fetchJson } from '../../src/data/download.js'
import { DataError, findTmEntry } from '../../src/data/manifest.js'
import { USER_AGENT } from '../../src/wporg/http.js'
import { bytes, chunked, redirect, serve, silent, type TestServer } from './server.js'

const sha512 = (b: Buffer | string) => createHash('sha512').update(b).digest('hex')
const MiB = 1024 * 1024

let dir: string
let server: TestServer | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polyglots-download-'))
})

afterEach(async () => {
  await server?.close()
  server = undefined
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

describe('download', () => {
  it('downloads and verifies', async () => {
    const body = Buffer.from('schema: 2\nguidance: hello\n')
    server = await serve({ '/f': bytes(body) })
    const path = await download(server.url('/f'), { maxBytes: MiB, sha512: sha512(body), dir })
    expect(path.startsWith(dir)).toBe(true)
    expect(await readFile(path)).toEqual(body)
    expect(server.requests[0]!.userAgent).toBe(USER_AGENT)
  })

  // A Ctrl-C mid-download skips the cleanup in download's catch, and tm fetch
  // writes into the data folder, where a hidden 40 MiB file would stay for
  // good. A fresh one may belong to a run still going, so only a day-old one
  // is taken to be abandoned.
  it('removes a partial download a day old, and keeps a fresh one and other files', async () => {
    const old = join(dir, '.polyglots-data-old')
    const fresh = join(dir, '.polyglots-data-fresh')
    const other = join(dir, '.other-old')
    for (const f of [old, fresh, other]) await writeFile(f, 'partial')
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    await utimes(old, twoDaysAgo, twoDaysAgo)
    await utimes(other, twoDaysAgo, twoDaysAgo)
    const body = 'x'
    server = await serve({ '/f': bytes(body) })
    const path = await download(server.url('/f'), { maxBytes: MiB, sha512: sha512(body), dir })
    expect((await readdir(dir)).sort()).toEqual(['.other-old', '.polyglots-data-fresh', path.slice(dir.length + 1)].sort())
  })

  it('creates the folder it is asked to write into', async () => {
    const body = 'x'
    server = await serve({ '/f': bytes(body) })
    const path = await download(server.url('/f'), { maxBytes: MiB, sha512: sha512(body), dir: join(dir, 'a', 'b') })
    expect(await readFile(path, 'utf8')).toBe('x')
  })

  it('refuses a hash mismatch and leaves no file', async () => {
    server = await serve({ '/f': bytes('tampered') })
    const url = server.url('/f')
    await expect(download(url, { maxBytes: MiB, sha512: sha512('original'), dir })).rejects.toThrow(
      `${url} does not match the sha512 in the manifest; nothing was written`,
    )
    expect(await readdir(dir)).toEqual([])
  })

  it('stops past maxBytes and leaves no file', async () => {
    server = await serve({ '/f': chunked(2 * MiB) })
    const err = await download(server.url('/f'), { maxBytes: MiB, sha512: 'a'.repeat(128), dir }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DataError)
    expect((err as Error).message).toMatch(/larger than 1048576 bytes/)
    expect(await readdir(dir)).toEqual([])
  })

  // A Content-Length already over the limit is refused before a byte of the
  // body is read, which saves downloading 200 MiB to be told it was too big.
  it('refuses a declared length past maxBytes without writing', async () => {
    server = await serve({ '/f': bytes(Buffer.alloc(2048)) })
    await expect(download(server.url('/f'), { maxBytes: 1024, sha512: 'a'.repeat(128), dir })).rejects.toThrow(/larger than 1024 bytes/)
    expect(await readdir(dir)).toEqual([])
  })

  it('follows a redirect', async () => {
    const body = 'moved'
    server = await serve({ '/old': redirect('/new'), '/new': bytes(body) })
    const path = await download(server.url('/old'), { maxBytes: MiB, sha512: sha512(body), dir })
    expect(await readFile(path, 'utf8')).toBe(body)
  })

  it('refuses a failed request and leaves no file', async () => {
    server = await serve({})
    const url = server.url('/missing')
    await expect(download(url, { maxBytes: MiB, sha512: 'a'.repeat(128), dir })).rejects.toThrow(`GET ${url} failed: 404`)
    expect(await readdir(dir)).toEqual([])
  })

  it('refuses an unreachable server as a DataError', async () => {
    server = await serve({})
    const url = server.url('/f')
    await server.close()
    server = undefined
    await expect(download(url, { maxBytes: MiB, sha512: 'a'.repeat(128), dir })).rejects.toThrow(DataError)
    expect(await readdir(dir)).toEqual([])
  })
})

describe('fetchJson', () => {
  it('reads JSON', async () => {
    server = await serve({ '/j': bytes('{"a":1}') })
    expect(await fetchJson(server.url('/j'), { maxBytes: 1024, timeoutMs: 5_000 })).toEqual({ a: 1 })
  })

  it('refuses a body past maxBytes', async () => {
    server = await serve({ '/j': chunked(MiB) })
    await expect(fetchJson(server.url('/j'), { maxBytes: 1024, timeoutMs: 5_000 })).rejects.toThrow(/larger than 1024 bytes/)
  })

  it('refuses a non-2xx answer', async () => {
    server = await serve({ '/j': bytes('busy', 503) })
    const url = server.url('/j')
    await expect(fetchJson(url, { maxBytes: 1024, timeoutMs: 5_000 })).rejects.toThrow(`GET ${url} failed: 503`)
  })

  it('refuses a body that is not JSON', async () => {
    server = await serve({ '/j': bytes('<html>') })
    await expect(fetchJson(server.url('/j'), { maxBytes: 1024, timeoutMs: 5_000 })).rejects.toThrow(DataError)
  })

  it('gives up on a server that stalls', async () => {
    server = await serve({ '/j': silent })
    await expect(fetchJson(server.url('/j'), { maxBytes: 1024, timeoutMs: 200 })).rejects.toThrow(/timed out after 200 ms/)
  })
})

describe('dataClient', () => {
  it('reads the manifest POLYGLOTS_DATA_URL names', async () => {
    const index = await readFile(join(import.meta.dirname, '..', 'fixtures', 'data', 'index.json'))
    server = await serve({ '/index.json': bytes(index) })
    vi.stubEnv('POLYGLOTS_DATA_URL', server.url('/index.json'))
    const m = await dataClient.manifest()
    expect(findTmEntry(m, 'tr').slug).toBe('tr')
  })
})
