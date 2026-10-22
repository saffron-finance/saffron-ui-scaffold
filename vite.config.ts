import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createRpcHandler } from './server/rpc.mjs'

export default defineConfig({
  plugins: [react(), {
    name: 'server-only-read-rpc',
    configureServer(server) {
      // Provider configuration stays in this Node process, never in client modules.
      const relay = createRpcHandler()
      server.middlewares.use((req, res, next) => {
        res.setHeader('Referrer-Policy', 'no-referrer')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        // Reject sensitive paths before Vite's module transforms and SPA fallback.
        let parts: string[]
        try { parts = decodeURIComponent(new URL(req.url!, 'http://localhost').pathname).split('/') }
        catch { res.writeHead(400); res.end('Invalid path'); return }
        if (parts.some(part => part === '.git' || part === '.npmrc' || part === '.env' ||
            part.startsWith('.env.') || part === 'server' || /\.(?:pem|key|crt)$/i.test(part))) {
          res.writeHead(403); res.end('Forbidden'); return
        }
        void relay(req, res).then(handled => { if (!handled) next() }).catch(() => {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
          res.end('{"error":"RPC unavailable"}')
        })
      })
    },
  }],
  base: './',
  // Disable Vite's automatic client environment exposure, including legacy VITE_*.
  // Only this parsed boolean is explicitly public. RPC_* is read by Node alone.
  envDir: false,
  envPrefix: [],
  define: { __STATIC_DEMO__: JSON.stringify(process.env.SAFFRON_STATIC_DEMO === 'true') },
  server: {
    host: '127.0.0.1', port: 5180,
    fs: { strict: true, deny: ['.env', '.env.*', '.npmrc', '*.{crt,pem,key}', '**/.git/**', '**/server/**'] },
  },
})
