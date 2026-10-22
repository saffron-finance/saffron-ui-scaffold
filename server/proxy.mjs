// Static production hosting plus the same server-only RPC relay used in development.
import { createServer } from 'node:http'
import { readFile, realpath } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRpcHandler } from './rpc.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const DIST = join(ROOT, 'dist')
const PORT = Number(process.env.PORT) || 3200
const HOST = process.env.BIND_HOST || '127.0.0.1'
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '')
const rpc = createRpcHandler({ basePath: BASE_PATH })
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
}

/** Serve only real, non-hidden files contained in dist, including after symlinks. */
async function staticFile(path) {
  const base = await realpath(DIST)
  const actual = await realpath(path)
  const inside = relative(base, actual)
  if (!inside || inside.startsWith('..') || inside.split('/').some(part => part.startsWith('.'))) throw new Error('forbidden')
  return readFile(actual)
}

/** All public errors are fixed messages; no filesystem paths or exceptions escape. */
function end(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(message)
}

const server = createServer(async (req, res) => {
  res.setHeader('Connection', 'close')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'")
  try {
    if (await rpc(req, res)) return
    const url = new URL(req.url, 'http://localhost')
    if (BASE_PATH && url.pathname !== BASE_PATH && !url.pathname.startsWith(`${BASE_PATH}/`)) return end(res, 404, 'not found')
    if (!['GET', 'HEAD'].includes(req.method)) return end(res, 405, 'GET only')
    let path
    try { path = decodeURIComponent(url.pathname.slice(BASE_PATH.length)) }
    catch { return end(res, 400, 'invalid path') }
    if (path.split('/').some(part => part.startsWith('.'))) return end(res, 403, 'forbidden')
    if (!path || path === '/') path = '/index.html'
    const file = resolve(DIST, `.${path}`)
    if (relative(DIST, file).startsWith('..')) return end(res, 403, 'forbidden')
    try {
      const data = await staticFile(file)
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
      res.end(req.method === 'HEAD' ? undefined : data)
    } catch {
      // SPA fallback is only for extensionless page routes, never a secret/asset path.
      if (extname(path)) return end(res, 404, 'not found')
      const data = await staticFile(join(DIST, 'index.html'))
      res.writeHead(200, { 'content-type': MIME['.html'] })
      res.end(req.method === 'HEAD' ? undefined : data)
    }
  } catch { if (!res.headersSent) end(res, 502, 'request unavailable'); else res.end() }
})

// Keep framing and slow-client limits bounded even behind a reverse proxy.
server.maxRequestsPerSocket = 1
server.requestTimeout = 30_000
server.headersTimeout = 15_000
server.on('clientError', (_error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
})
server.listen(PORT, HOST, () => console.log(`Saffron UI listening on port ${PORT}`))
