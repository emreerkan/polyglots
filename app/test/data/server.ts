import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

// A real HTTP server on a loopback port, rather than a stubbed fetch: the
// download code's job is streaming, redirects and a body cut off part way,
// and a stub that hands back a whole Response at once proves none of that.

export type Route = (req: IncomingMessage, res: ServerResponse) => void

export interface TestServer {
  url(path: string): string
  /** Every request the server answered, path and User-Agent, in order. */
  requests: { path: string; userAgent: string | undefined }[]
  close(): Promise<void>
}

export async function serve(routes: Record<string, Route>): Promise<TestServer> {
  const requests: TestServer['requests'] = []
  const server = createServer((req, res) => {
    const path = req.url ?? '/'
    requests.push({ path, userAgent: req.headers['user-agent'] })
    const route = routes[path]
    if (route) route(req, res)
    else res.writeHead(404).end('not here')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** The whole body at once, with its Content-Length. */
export const bytes =
  (body: Buffer | string, status = 200): Route =>
  (_req, res) => {
    res.writeHead(status, { 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
  }

/**
 * `total` bytes of `x` in 64 KiB chunks with no Content-Length, so a size
 * limit can only be enforced by counting what arrives.
 */
export const chunked =
  (total: number): Route =>
  (_req, res) => {
    res.writeHead(200)
    const chunk = Buffer.alloc(64 * 1024, 'x')
    let sent = 0
    const pump = (): void => {
      while (sent < total) {
        const n = Math.min(chunk.length, total - sent)
        sent += n
        if (!res.write(chunk.subarray(0, n))) {
          res.once('drain', pump)
          return
        }
      }
      res.end()
    }
    res.on('error', () => undefined)
    pump()
  }

export const redirect =
  (to: string, status = 302): Route =>
  (_req, res) => {
    res.writeHead(status, { Location: to }).end()
  }

/** Answers headers, then nothing: a server that stalls. */
export const silent: Route = (_req, res) => {
  res.writeHead(200)
  res.flushHeaders()
}
