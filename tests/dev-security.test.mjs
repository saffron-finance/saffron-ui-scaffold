import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, writeFile, symlink, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('../', import.meta.url))
const sentinel = 'FAKE_DEVELOPMENT_SECRET_TEST_ONLY'
let fixture, upstream, child, base, seenUrl, logs = ''

/** Use an isolated project copy: never read or modify an operator's real .env. */
before(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'saffron-dev-security-'))
  for (const name of ['server', 'src', 'public', 'vite.config.ts', 'package.json', 'index.html']) {
    await cp(join(root, name), join(fixture, name), { recursive: true })
  }
  await symlink(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir')
  await writeFile(join(fixture, 'src/probe.ts'), 'export const env = import.meta.env\n')
  upstream = createServer(async (req, res) => {
    seenUrl = req.url
    let body = ''
    for await (const chunk of req) body += chunk
    res.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: '0x1' }))
  }).listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  await writeFile(join(fixture, '.env'), `RPC_ETHEREUM="http://127.0.0.1:${upstream.address().port}/${sentinel}"\n`)
  await writeFile(join(fixture, '.env.local'), `VITE_OTHER_SECRET=${sentinel}\n`)
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'], {
    cwd: fixture, env: { PATH: process.env.PATH, VITE_OTHER_SECRET: sentinel }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', data => { logs += data })
  child.stderr.on('data', data => { logs += data })
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error('Development server exited before startup')
    try { if ((await fetch(base, { signal: AbortSignal.timeout(500) })).ok) return }
    catch { /* Wait only for this disposable server, not an external service. */ }
    await delay(50)
  }
  throw new Error('Development server did not start')
})

after(async () => {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
  if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) }
  if (fixture) await rm(fixture, { recursive: true, force: true })
})

test('development uses the same server-only RPC configuration', async () => {
  const response = await fetch(base + '/rpc/ethereum', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'eth_chainId', params: [] }),
  })
  assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 9, result: '0x1' })
  assert.equal(seenUrl, '/' + sentinel)
})

test('development modules never expose RPC or arbitrary VITE_ environment values', async () => {
  for (const path of ['/src/probe.ts', '/src/chain/chains.ts', '/src/mock/mode.ts', '/@vite/env']) {
    const response = await fetch(base + path)
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.doesNotMatch(body, new RegExp(sentinel))
    assert.doesNotMatch(body, /VITE_OTHER_SECRET|RPC_ETHEREUM/)
  }
  assert.doesNotMatch(logs, new RegExp(sentinel))
})

test('development cannot serve dotenv, Git or server implementation files', async () => {
  for (const path of ['/.env', '/.env?raw', '/.env.local', '/.git/config', '/.npmrc',
    '/server/rpc.mjs', '/server/rpc.mjs?raw', `/@fs${fixture}/.env`]) {
    const response = await fetch(base + path)
    assert.ok([403, 404].includes(response.status), path)
    assert.doesNotMatch(await response.text(), new RegExp(sentinel))
  }
})

test('legacy browser-prefixed RPC credentials fail startup without disclosing their value', async () => {
  const run = promisify(execFile)
  await assert.rejects(run(process.execPath, ['--input-type=module', '-e',
    "import { createRpcHandler } from './server/rpc.mjs'; createRpcHandler()"], {
    cwd: fixture, env: { PATH: process.env.PATH, VITE_RPC_ETHEREUM: sentinel },
  }), error => {
    assert.match(error.stderr, /Use server-only RPC_/)
    assert.doesNotMatch(error.stderr, new RegExp(sentinel))
    return true
  })
})
