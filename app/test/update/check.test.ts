import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CHECK_EVERY_MS,
  RETRY_AFTER_MS,
  checkForUpdate,
  isNewer,
  updateCheckEnabled,
  updateCommand,
  updateStateFile,
} from '../../src/update/index.js'

describe('isNewer', () => {
  it.each([
    ['0.27.0', '0.26.2', true],
    ['0.26.10', '0.26.9', true],
    ['1.0.0', '0.99.99', true],
    ['0.26.2', '0.26.2', false],
    ['0.26.1', '0.26.2', false],
  ])('%s over %s is %s', (latest, current, expected) => {
    expect(isNewer(latest, current)).toBe(expected)
  })

  // Only the latest tag is read, and a pre-release published there by
  // mistake is not something to send everyone to.
  it('never offers a pre-release or something that is not a version', () => {
    expect(isNewer('1.0.0-beta.1', '0.26.2')).toBe(false)
    expect(isNewer('latest', '0.26.2')).toBe(false)
  })

  // A checkout ahead of the registry, or a local pre-release build, has
  // nothing to update to.
  it('reads a current pre-release as its release', () => {
    expect(isNewer('0.27.0', '0.27.0-rc.1')).toBe(false)
    expect(isNewer('0.27.1', '0.27.0-rc.1')).toBe(true)
  })
})

describe('updateCheckEnabled', () => {
  it('is on unless something says otherwise', () => {
    expect(updateCheckEnabled({}, {})).toBe(true)
    expect(updateCheckEnabled({ updateCheck: true }, {})).toBe(true)
  })

  it.each([
    ['the setting', { updateCheck: false }, {}],
    ['NO_UPDATE_NOTIFIER', {}, { NO_UPDATE_NOTIFIER: '1' }],
    ['CI', {}, { CI: 'true' }],
  ])('is off when %s says so', (_what, config, env) => {
    expect(updateCheckEnabled(config, env)).toBe(false)
  })

  // Asking npm for a version number tracks nobody, and the owner wants it on
  // whatever DO_NOT_TRACK says.
  it('ignores DO_NOT_TRACK', () => {
    expect(updateCheckEnabled({}, { DO_NOT_TRACK: '1' })).toBe(true)
  })
})

describe('updateCommand', () => {
  it('names npm for an installed package', () => {
    const root = mkdtempSync(join(tmpdir(), 'polyglots-pkg-'))
    expect(updateCommand(join(root, 'node_modules', 'polyglots'))).toBe('npm install -g polyglots')
  })

  // npm install -g would put a second copy beside the linked checkout.
  it('names git for a checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'polyglots-repo-'))
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'app'))
    expect(updateCommand(join(root, 'app'))).toBe('git pull && npm ci && npm run build')
  })
})

describe('checkForUpdate', () => {
  let server: Server
  let url: string
  let hits: number
  let reply: { status: number; body: string }

  beforeEach(async () => {
    hits = 0
    reply = { status: 200, body: JSON.stringify({ name: 'polyglots', version: '9.9.9' }) }
    server = createServer((_req, res) => {
      hits++
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(reply.body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/polyglots/latest`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const at = (now: number) => ({ url, version: '0.26.2', now: () => now })

  it('asks the registry and says which version is newer', async () => {
    expect(await checkForUpdate(at(1000))).toBe('9.9.9')
    expect(hits).toBe(1)
    expect(JSON.parse(readFileSync(updateStateFile(), 'utf8'))).toMatchObject({ checkedAt: 1000, latest: '9.9.9' })
  })

  it('answers from the saved check for a day, then asks again', async () => {
    await checkForUpdate(at(1000))
    expect(await checkForUpdate(at(1000 + CHECK_EVERY_MS - 1))).toBe('9.9.9')
    expect(hits).toBe(1)
    reply.body = JSON.stringify({ version: '10.0.0' })
    expect(await checkForUpdate(at(1000 + CHECK_EVERY_MS))).toBe('10.0.0')
    expect(hits).toBe(2)
  })

  it('says nothing when the running version is the latest', async () => {
    reply.body = JSON.stringify({ version: '0.26.2' })
    expect(await checkForUpdate(at(1000))).toBeUndefined()
  })

  // A failed request never fails a command, and leaves the last answer in
  // place until the next day's attempt.
  it('keeps the saved answer when the registry cannot be reached', async () => {
    mkdirSync(dirname(updateStateFile()), { recursive: true })
    writeFileSync(updateStateFile(), JSON.stringify({ checkedAt: 0, latest: '9.9.9' }))
    reply = { status: 503, body: 'down' }
    expect(await checkForUpdate(at(CHECK_EVERY_MS))).toBe('9.9.9')
    expect(await checkForUpdate({ ...at(CHECK_EVERY_MS + RETRY_AFTER_MS), url: 'http://127.0.0.1:9/' })).toBe('9.9.9')
    expect(JSON.parse(readFileSync(updateStateFile(), 'utf8')).checkedAt).toBe(0)
  })

  // Only an answer counts as a check. A lost request is tried again an hour
  // later, not a day, and leaves when the last answer came unchanged.
  it('retries a lost request after an hour, without counting it as checked', async () => {
    reply = { status: 503, body: 'down' }
    expect(await checkForUpdate(at(1000))).toBeUndefined()
    expect(JSON.parse(readFileSync(updateStateFile(), 'utf8')).checkedAt).toBeUndefined()
    await checkForUpdate(at(1000 + RETRY_AFTER_MS - 1))
    expect(hits).toBe(1)
    reply = { status: 200, body: JSON.stringify({ version: '9.9.9' }) }
    expect(await checkForUpdate(at(1000 + RETRY_AFTER_MS))).toBe('9.9.9')
    expect(hits).toBe(2)
    expect(JSON.parse(readFileSync(updateStateFile(), 'utf8')).checkedAt).toBe(1000 + RETRY_AFTER_MS)
  })

  it('treats a reply that is not a manifest as no answer', async () => {
    reply.body = '<html>'
    expect(await checkForUpdate(at(1000))).toBeUndefined()
  })

  // Written before the request goes, so two commands started together ask once.
  it('asks once when two checks start together', async () => {
    await Promise.all([checkForUpdate(at(1000)), checkForUpdate(at(1000))])
    expect(hits).toBe(1)
  })
})
