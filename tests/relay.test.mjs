import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

let upstream, child, base, calls = 0
const rpc = { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }

/** Start a disposable loopback relay and fake read-only upstream; no chain writes. */
before(async () => {
  upstream = createServer((req, res) => {
    calls++
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }))
  }).listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['server/proxy.mjs'], {
    env: { ...process.env, PORT: String(port), RPC_ETHEREUM: `http://127.0.0.1:${upstream.address().port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('Relay exited before startup') })])
})
after(async () => {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
  if (upstream) await new Promise((resolve) => upstream.close(resolve))
})
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })

test('static UI and SPA route are served', async () => {
  for (const path of ['/', '/example-route']) {
    const response = await fetch(base + path)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /<div id="root"><\/div>/)
  }
})
test('allowlisted read reaches upstream', async () => {
  const response = await post('/rpc/ethereum', rpc)
  assert.equal(response.status, 200); assert.equal((await response.json()).result, '0x1')
})
test('transaction and signing methods never reach upstream', async () => {
  const before = calls
  for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'personal_sign', 'debug_traceCall']) {
    assert.equal((await post('/rpc/ethereum', { ...rpc, method })).status, 403)
  }
  assert.equal(calls, before)
})
test('mixed batches and malformed JSON are rejected', async () => {
  const before = calls
  for (const body of ['{', [], { ...rpc, jsonrpc: '1.0' }, { ...rpc, params: {} }, [rpc, { ...rpc, method: 'eth_sendTransaction' }]]) {
    assert.equal((await post('/rpc/ethereum', body)).status, 403)
  }
  assert.equal(calls, before)
})
test('unknown or inherited chain names and non-POST reads are rejected', async () => {
  for (const key of ['missing', '__proto__', 'constructor']) assert.equal((await post(`/rpc/${key}`, rpc)).status, 404)
  assert.equal((await fetch(base + '/rpc/ethereum')).status, 405)
})
test('oversized body is rejected', async () => {
  assert.equal((await post('/rpc/ethereum', 'x'.repeat(2_000_001))).status, 413)
})
test('encoded traversal and malformed paths cannot escape or crash the server', async () => {
  assert.equal((await fetch(base + '/%2e%2e%2fpackage.json')).status, 403)
  assert.equal((await fetch(base + '/%FF')).status, 400)
  assert.equal((await fetch(base + '/')).status, 200)
})
