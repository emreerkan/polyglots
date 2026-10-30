import { createHash } from 'node:crypto'
import { EDITOR_JS } from './client-bundle.js'

// The page the local editor server sends: an empty #root and the bundle,
// which brings its own stylesheet and mounts the editor. Everything the page
// shows comes from GET data afterwards, so the shell carries no glossary text
// and needs no escaping beyond the script itself.
//
// Light only, as the editor's stylesheet is: the people using it spend their
// day in wp-admin and GlotPress. The shell says so too, so the browser does
// not paint a dark canvas behind the light grid while the bundle loads.

export interface EditorDocument {
  html: string
  // The policy the server also sends as a header.
  csp: string
}

const hash = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`

// A script element ends at the first "</script" whatever the JavaScript
// around it means; "<\/" is the same string to the script.
const inlineScript = (code: string) => code.replace(/<\/(script)/gi, '<\\/$1')

const SHELL_STYLE = 'html{color-scheme:light}body{margin:0;background:#f0f0f1;color:#1d2327}'

export function renderEditorDocument(): EditorDocument {
  const script = inlineScript(EDITOR_JS)
  const csp = [
    "default-src 'none'",
    `script-src ${hash(script)}`,
    // The bundle adds its stylesheet as a <style> element at run time, and
    // the server cannot hash it without loading the page's own modules into
    // the CLI. Inline style is allowed instead. With default-src 'none' and no
    // img-src or font-src, a style that someone managed to inject could load
    // nothing, which is the way a stylesheet leaks a page; the script, which
    // could, stays pinned by hash.
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
  const html =
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<meta name="referrer" content="no-referrer">` +
    `<title>polyglots · Glossary editor</title>` +
    `<style>${SHELL_STYLE}</style></head><body>` +
    `<div id="root"></div>` +
    `<script>${script}</script></body></html>`
  return { html, csp }
}
