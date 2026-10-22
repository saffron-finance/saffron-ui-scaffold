import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

let upstream, child, base, reply, calls = 0
const rpc = { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }

/** Start a disposable loopback relay and fake read-only upstream; no chain writes. */
before(async () => {
  upstream = createServer(async (req, res) => {
    calls++
    let raw = ''
    for await (const chunk of req) raw += chunk
    const request = JSON.parse(raw)
    if (reply) return reply(req, res, request)
    res.writeHead(200, { 'content-type': 'application/json' })
    const result = item => ({ jsonrpc: '2.0', id: item.id, result: '0x1' })
    res.end(JSON.stringify(Array.isArray(request) ? request.map(result) : result(request)))
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
beforeEach(() => { reply = undefined })
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

const fakeSecret = 'FAKE_PROVIDER_CREDENTIAL_FOR_TEST_ONLY'

test('HTTP provider errors and response headers cannot disclose credentials', async () => {
  reply = (_req, res) => {
    res.writeHead(401, { 'x-provider-debug': fakeSecret })
    res.end(`https://example.invalid/${fakeSecret}`)
  }
  const response = await post('/rpc/ethereum', rpc)
  assert.equal(response.status, 502)
  assert.equal(response.headers.get('x-provider-debug'), null)
  assert.doesNotMatch(await response.text(), new RegExp(fakeSecret))
})

test('JSON-RPC errors under HTTP 200 discard message, data and diagnostic fields', async () => {
  reply = (_req, res, request) => res.end(JSON.stringify({
    jsonrpc: '2.0', id: request.id, diagnostic: fakeSecret,
    error: { code: -32005, message: fakeSecret, data: { url: fakeSecret } },
  }))
  const response = await post('/rpc/ethereum', rpc)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'RPC read failed' } })
})

test('successful results discard provider diagnostic fields', async () => {
  reply = (_req, res) => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1', endpoint: fakeSecret }))
  assert.deepEqual(await (await post('/rpc/ethereum', rpc)).json(), { jsonrpc: '2.0', id: 1, result: '0x1' })
})

test('malformed, mismatched and non-Ethereum success bodies fail closed', async () => {
  for (const body of [fakeSecret,
    { jsonrpc: '2.0', id: 1, result: fakeSecret },
    { jsonrpc: '2.0', id: 99, result: '0x1' },
    { jsonrpc: '2.0', id: 1, result: '0x1', error: { message: fakeSecret } },
  ]) {
    reply = (_req, res) => res.end(typeof body === 'string' ? body : JSON.stringify(body))
    const response = await post('/rpc/ethereum', rpc)
    assert.equal(response.status, 502)
    assert.doesNotMatch(await response.text(), new RegExp(fakeSecret))
  }
})

test('batch responses are ID-correlated, sanitized and returned in caller order', async () => {
  reply = (_req, res, request) => res.end(JSON.stringify([
    { jsonrpc: '2.0', id: request[1].id, error: { code: -1, message: fakeSecret } },
    { jsonrpc: '2.0', id: request[0].id, result: '0x1', metadata: fakeSecret },
  ]))
  const response = await post('/rpc/ethereum', [rpc, { ...rpc, id: 'second' }])
  assert.deepEqual(await response.json(), [
    { jsonrpc: '2.0', id: 1, result: '0x1' },
    { jsonrpc: '2.0', id: 'second', error: { code: -32603, message: 'RPC read failed' } },
  ])
})

test('missing or duplicate response IDs reject the entire batch', async () => {
  reply = (_req, res) => res.end(JSON.stringify([
    { jsonrpc: '2.0', id: 1, result: '0x1' }, { jsonrpc: '2.0', id: 1, result: '0x1' },
  ]))
  assert.equal((await post('/rpc/ethereum', [rpc, { ...rpc, id: 2 }])).status, 502)
})

test('request IDs, batch sizes and block-read modes are bounded', async () => {
  const before = calls
  for (const body of [[rpc, rpc], Array.from({ length: 101 }, (_, id) => ({ ...rpc, id })),
    { ...rpc, id: null }, { ...rpc, method: 'eth_getBlockByNumber', params: ['latest', true] },
  ]) assert.equal((await post('/rpc/ethereum', body)).status, 403)
  assert.equal(calls, before)
})

test('redirects never forward requests to another endpoint', async () => {
  const before = calls
  reply = (_req, res) => { res.writeHead(302, { location: `${base}/rpc/ethereum?${fakeSecret}` }); res.end(fakeSecret) }
  assert.equal((await post('/rpc/ethereum', rpc)).status, 502)
  assert.equal(calls, before + 1)
})

test('oversized successful provider bodies are bounded and never reflected', async () => {
  reply = (_req, res) => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: fakeSecret.repeat(250000) }))
  const response = await post('/rpc/ethereum', rpc)
  assert.equal(response.status, 502)
  assert.ok((await response.text()).length < 100)
})

test('cross-origin browser and non-JSON requests never consume provider calls', async () => {
  const before = calls
  for (const headers of [{ 'content-type': 'text/plain' },
    { 'content-type': 'application/json', origin: 'https://other.invalid' },
    { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
  ]) {
    const response = await fetch(base + '/rpc/ethereum', { method: 'POST', headers, body: JSON.stringify(rpc) })
    assert.ok([403, 415].includes(response.status))
  }
  assert.equal(calls, before)
})

test('static responses suppress referrers and disallow third-party assets', async () => {
  const response = await fetch(base + '/')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/)
  for (const path of ['/.env', '/.git/config', '/missing.js']) {
    assert.ok([403, 404].includes((await fetch(base + path)).status))
  }
})

test('valid log results preserve chain data but drop provider-added metadata', async () => {
  const log = { address: '0x' + '12'.repeat(20), data: '0x', topics: ['0x' + '34'.repeat(32)],
    blockNumber: '0x1', blockHash: '0x' + '56'.repeat(32), transactionHash: '0x' + '78'.repeat(32),
    transactionIndex: '0x0', logIndex: '0x0', removed: false }
  reply = (_req, res) => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [{ ...log, providerToken: fakeSecret }] }))
  const response = await post('/rpc/ethereum', { ...rpc, method: 'eth_getLogs', params: [{}] })
  assert.deepEqual((await response.json()).result, [log])
})

test('valid block and withdrawal data remain readable without diagnostic extensions', async () => {
  const withdrawal = { index: '0x1', validatorIndex: '0x2', address: '0x' + '12'.repeat(20), amount: '0x3' }
  const block = { number: '0x1', hash: '0x' + '34'.repeat(32), timestamp: '0x4', transactions: [],
    withdrawals: [{ ...withdrawal, providerToken: fakeSecret }], providerToken: fakeSecret }
  reply = (_req, res) => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: block }))
  const response = await post('/rpc/ethereum', { ...rpc, method: 'eth_getBlockByNumber', params: ['latest', false] })
  assert.deepEqual((await response.json()).result, { number: block.number, hash: block.hash,
    timestamp: block.timestamp, transactions: [], withdrawals: [withdrawal] })
})
