import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_getLogs', 'eth_getBlockByNumber', 'eth_getCode', 'net_version'])
const FALLBACKS = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  base: 'https://base-rpc.publicnode.com',
  bnb: 'https://bsc-rpc.publicnode.com',
  robinhood: undefined,
}
const MAX_REQUEST = 2_000_000
const MAX_RESPONSE = 8_000_000
const MAX_BATCH = 100
const quantity = value => typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
const bytes = value => typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value)
const hexOf = length => value => typeof value === 'string' && new RegExp(`^0x[0-9a-f]{${length * 2}}$`, 'i').test(value)
const nullable = check => value => value === null || check(value)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const has = (value, key) => Object.hasOwn(value, key)
const hash = hexOf(32)
const address = hexOf(20)

/** Read ignored local configuration only in Node. Never export values to Vite. */
function targetsFor(root) {
  let local = {}
  try { local = parseEnv(readFileSync(join(root, '.env'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read server RPC configuration') }
  if (Object.keys({ ...local, ...process.env }).some(key => key.startsWith('VITE_RPC_') && (process.env[key] || local[key]))) {
    throw new Error('Use server-only RPC_* settings; remove legacy VITE_RPC_* settings')
  }
  return Object.fromEntries(Object.entries(FALLBACKS).map(([chain, fallback]) => {
    const key = `RPC_${chain.toUpperCase()}`
    const target = (process.env[key] || local[key] || fallback)?.trim()
    if (target) {
      try {
        const url = new URL(target)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
      } catch { throw new Error(`Invalid server RPC configuration for ${chain}`) }
    }
    return [chain, target]
  }))
}

/** Bound request memory in bytes; drain an oversized request without storing it. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_REQUEST) { chunks.length = 0; reject(new Error('body limit')); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('request aborted')))
  })
}

/** Bound decoded response bytes too, including chunked/compressed responses. */
async function readResponse(response) {
  if (!response.body) throw new Error('empty upstream response')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_RESPONSE) throw new Error('response limit')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => {}) }
}

/** Keep only defined Ethereum fields; provider diagnostic extensions are dropped. */
function pickFields(value, schema, required) {
  if (!record(value) || required.some(key => !has(value, key))) throw new Error('invalid RPC result')
  const result = {}
  for (const [key, check] of Object.entries(schema)) {
    if (!has(value, key)) continue
    if (!check(value[key])) throw new Error('invalid RPC result')
    result[key] = value[key]
  }
  return result
}

const LOG_FIELDS = {
  address, data: bytes, topics: value => Array.isArray(value) && value.length <= 4 && value.every(hash),
  blockNumber: nullable(quantity), blockHash: nullable(hash), transactionHash: nullable(hash),
  transactionIndex: nullable(quantity), logIndex: nullable(quantity), removed: value => typeof value === 'boolean',
}
const BLOCK_FIELDS = {
  number: nullable(quantity), hash: nullable(hash), parentHash: hash, nonce: nullable(hexOf(8)),
  sha3Uncles: hash, logsBloom: nullable(hexOf(256)), transactionsRoot: hash, stateRoot: hash,
  receiptsRoot: hash, miner: address, mixHash: hash, difficulty: quantity, totalDifficulty: quantity,
  extraData: bytes, size: quantity, gasLimit: quantity, gasUsed: quantity, timestamp: quantity,
  baseFeePerGas: quantity, blobGasUsed: quantity, excessBlobGas: quantity,
  parentBeaconBlockRoot: hash, withdrawalsRoot: hash, requestsHash: hash,
  transactions: value => Array.isArray(value) && value.every(hash),
  uncles: value => Array.isArray(value) && value.every(hash),
}

/** Validate successful results as well as errors; never reflect arbitrary text. */
function safeResult(method, value) {
  if (['eth_chainId', 'eth_blockNumber'].includes(method) && quantity(value)) return value
  if (method === 'net_version' && typeof value === 'string' && /^\d{1,32}$/.test(value)) return value
  if (['eth_call', 'eth_getCode'].includes(method) && bytes(value)) return value
  if (method === 'eth_getLogs' && Array.isArray(value)) {
    return value.map(log => pickFields(log, LOG_FIELDS, ['address', 'data', 'topics']))
  }
  if (method === 'eth_getBlockByNumber') {
    if (value === null) return null
    const block = pickFields(value, BLOCK_FIELDS, ['number', 'hash', 'timestamp', 'transactions'])
    if (has(value, 'withdrawals')) {
      if (!Array.isArray(value.withdrawals)) throw new Error('invalid withdrawals')
      block.withdrawals = value.withdrawals.map(item => pickFields(item,
        { index: quantity, validatorIndex: quantity, address, amount: quantity },
        ['index', 'validatorIndex', 'address', 'amount']))
    }
    return block
  }
  throw new Error('invalid RPC result')
}

/** Accept only bounded, correlated requests, with no arbitrary forwarding fields. */
function requestsFor(raw) {
  const parsed = JSON.parse(raw)
  const calls = Array.isArray(parsed) ? parsed : [parsed]
  if (!calls.length || calls.length > MAX_BATCH) throw new Error('invalid batch')
  const seen = new Set()
  const clean = calls.map(call => {
    if (!record(call) || call.jsonrpc !== '2.0' || !METHODS.has(call.method) ||
        !(typeof call.id === 'string' && call.id.length <= 128 || Number.isSafeInteger(call.id)) ||
        call.params !== undefined && !Array.isArray(call.params)) throw new Error('invalid call')
    const key = JSON.stringify(call.id)
    if (seen.has(key)) throw new Error('duplicate id')
    seen.add(key)
    // Full transaction objects are not used by this UI; keep this read bounded.
    if (call.method === 'eth_getBlockByNumber' && call.params?.[1] !== false) throw new Error('full transactions disabled')
    return { jsonrpc: '2.0', id: call.id, method: call.method, params: call.params ?? [] }
  })
  return { calls: clean, batch: Array.isArray(parsed) }
}

/** Match IDs even when a provider reverses a batch, and strip all error details. */
function safeResponses(payload, calls, batch) {
  const responses = batch ? payload : [payload]
  if (!Array.isArray(responses) || responses.length !== calls.length) throw new Error('invalid response count')
  const indexed = new Map()
  for (const item of responses) {
    if (!record(item) || item.jsonrpc !== '2.0' || has(item, 'result') === has(item, 'error')) throw new Error('invalid envelope')
    const id = JSON.stringify(item.id)
    if (indexed.has(id)) throw new Error('duplicate response')
    indexed.set(id, item)
  }
  const result = calls.map(call => {
    const item = indexed.get(JSON.stringify(call.id))
    if (!item) throw new Error('unmatched response')
    return has(item, 'error')
      ? { jsonrpc: '2.0', id: call.id, error: { code: -32603, message: 'RPC read failed' } }
      : { jsonrpc: '2.0', id: call.id, result: safeResult(call.method, item.result) }
  })
  return batch ? result : result[0]
}

/** Return only our own fixed messages, never an upstream body, URL or exception. */
function end(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}

/** Create a shared dev/production read relay. Returns false for non-RPC routes. */
export function createRpcHandler({ root = ROOT, basePath = '' } = {}) {
  const targets = targetsFor(root)
  let active = 0
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const prefix = `${basePath}/rpc/`
    if (!url.pathname.startsWith(prefix)) return false
    const chain = url.pathname.slice(prefix.length).replace(/\/$/, '')
    if (!has(targets, chain) || !targets[chain]) { end(res, 404, { error: 'RPC unavailable for this chain' }); return true }
    if (req.method !== 'POST') { end(res, 405, { error: 'POST only' }); return true }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      end(res, 415, { error: 'JSON required' }); return true
    }
    // Browser cross-site requests must not consume this operator's RPC quota.
    let wrongOrigin = false
    try { wrongOrigin = !!req.headers.origin && new URL(req.headers.origin).host !== req.headers.host }
    catch { wrongOrigin = true }
    if (wrongOrigin || req.headers['sec-fetch-site'] === 'cross-site') {
      end(res, 403, { error: 'Same-origin requests only' }); return true
    }
    if (active >= 16) { end(res, 503, { error: 'RPC relay busy' }); return true }
    active++
    try {
      let body, parsed
      try { body = await readBody(req) }
      catch { end(res, 413, { error: 'Invalid or oversized request' }); return true }
      try { parsed = requestsFor(body) }
      catch { end(res, 403, { error: 'RPC request not allowed' }); return true }
      try {
        const upstream = await fetch(targets[chain], {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(parsed.batch ? parsed.calls : parsed.calls[0]),
          signal: AbortSignal.timeout(20_000), redirect: 'error',
        })
        if (!upstream.ok) { await upstream.body?.cancel(); throw new Error('upstream status') }
        const payload = safeResponses(await readResponse(upstream), parsed.calls, parsed.batch)
        end(res, 200, payload)
      } catch { end(res, 502, { error: 'RPC upstream unavailable' }) }
      return true
    } finally { active-- }
  }
}
