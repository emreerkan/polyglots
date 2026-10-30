import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM script without types
import { bundleClient, renderBundleModule } from '../../../scripts/glossary-client.mjs'

const committed = readFileSync(join(import.meta.dirname, '..', '..', '..', 'src', 'glossary', 'editor', 'client-bundle.ts'), 'utf8')

describe('the glossary editor client bundle', () => {
  // Generated and committed, as the stats bundle is, so the package never
  // needs esbuild at run time. A page change that skipped
  // `npm run glossary-client` would ship the old editor; this catches it.
  it('is current with src/glossary/editor/page', async () => {
    expect(committed).toBe(renderBundleModule(await bundleClient()))
  }, 30_000)

  it('stays small enough to inline into the page', async () => {
    const code: string = await bundleClient()
    expect(code.length).toBeLessThan(80_000)
  }, 30_000)

  // The page imports the model, the sidecar reader and the CSV module from
  // shared code; one of them growing a storage import would land here first.
  it('carries no node: import or require, which would break in the browser', async () => {
    const code: string = await bundleClient()
    expect(code).not.toMatch(/\bnode:/)
    expect(code).not.toMatch(/\brequire\(/)
  }, 30_000)

  // The local server inlines the bundle into a <script> element, where this
  // sequence would end the script early.
  it('can be inlined into a script element as it is', async () => {
    const code: string = await bundleClient()
    expect(code).not.toMatch(/<\/script/i)
  }, 30_000)
})
