import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { decodeAbiParameters } from 'viem'

// Bundle the real transaction coordinator, replacing only the injected-wallet
// boundary. These are behavioral tests, not live broadcasts or fork tests.
const bundle = await build({
  entryPoints: ['src/wallet/deposit.ts'], bundle: true, write: false,
  platform: 'node', format: 'esm', define: { 'import.meta.env.PROD': 'true' },
  plugins: [{ name: 'wallet-test-boundary', setup(builder) {
    builder.onLoad({ filter: /\/wallet\/wallet\.ts$/ }, () => ({
      contents: `export const ensureChain = async () => {};
        export const walletClient = () => globalThis.depositTest.wc;
        export const walletPublicClient = () => globalThis.depositTest.pub;`,
      loader: 'js',
    }))
  } }],
})
const { depositVariable } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const address = (n) => `0x${n.toString(16).padStart(40, '0')}`
const account = address(1)
const vault = { chainKey: 'ethereum', vault: address(2), variableAsset: address(3), variableBearer: address(4), variableAssetDecimals: 6, variableAssetSymbol: 'TEST', isStarted: false, earningsSettled: false }

/** Construct a deterministic wallet boundary and capture every requested write. */
function scenario(overrides = {}) {
  const s = { allowance: 0n, balance: 10_000_000n, capacity: 10_000_000n, supply: 0n, started: false, decimals: 6, account, chain: 1, writes: [], steps: [], ...overrides }
  s.wc = {
    getAddresses: async () => [s.account], getChainId: async () => s.chain,
    writeContract: async (request) => {
      s.writes.push(request)
      if (s.afterWrite) s.afterWrite(request)
      return `0x${s.writes.length.toString(16).padStart(64, '0')}`
    },
  }
  s.pub = {
    readContract: async ({ functionName }) => ({
      isStarted: s.started, earningsSettled: false, variableSideCapacity: s.capacity,
      variableAsset: vault.variableAsset, variableBearerToken: vault.variableBearer,
      decimals: s.decimals, totalSupply: s.supply, balanceOf: s.balance, allowance: s.allowance,
    })[functionName],
    waitForTransactionReceipt: async () => ({ status: s.revert === s.writes.at(-1).functionName ? 'reverted' : 'success' }),
    simulateContract: async (request) => {
      if (s.simulationFailure) throw new Error('Deposit simulation reverted')
      s.simulation = request
      return { request }
    },
  }
  globalThis.depositTest = s
  s.run = (amount = '1') => depositVariable(vault, amount, account, (step) => s.steps.push(step))
  return s
}

test('exact approval, variable-side calldata and confirmed receipt', async () => {
  const s = scenario()
  const result = await s.run()
  assert.deepEqual(s.writes.map((w) => w.functionName), ['approve', 'deposit'])
  assert.deepEqual(s.writes[0].args, [vault.vault, 1_000_000n])
  assert.deepEqual(s.writes[1].args.slice(0, 2), [1_000_000n, 1n])
  assert.equal(decodeAbiParameters([{ type: 'uint256' }], s.writes[1].args[2])[0], 1_000_000n)
  assert.equal(s.writes[1].address, vault.vault)
  assert.equal(s.steps.at(-1), 'done')
  assert.match(result.hash, /^0x[0-9a-f]{64}$/)
})
test('existing adequate allowance skips approval', async () => {
  const s = scenario({ allowance: 1_000_000n }); await s.run()
  assert.deepEqual(s.writes.map((w) => w.functionName), ['deposit'])
})
test('nonzero insufficient allowance uses zero-first exact approval', async () => {
  const s = scenario({ allowance: 1n }); await s.run()
  assert.deepEqual(s.writes.map((w) => w.functionName), ['approve', 'approve', 'deposit'])
  assert.equal(s.writes[0].args[1], 0n); assert.equal(s.writes[1].args[1], 1_000_000n)
})
for (const action of ['approve', 'deposit']) test(`reverted ${action} receipt never reports success`, async () => {
  const s = scenario({ revert: action })
  await assert.rejects(s.run(), /reverted/)
  assert.ok(!s.steps.includes('done'))
  if (action === 'approve') assert.equal(s.writes.length, 1)
})
for (const [name, changes, reason] of [
  ['stale started vault', { started: true }, /no longer open/],
  ['insufficient capacity', { capacity: 500_000n }, /capacity/],
  ['insufficient balance', { balance: 1n }, /Insufficient/],
  ['changed account', { account: address(99) }, /account or network/],
  ['wrong network', { chain: 8453 }, /account or network/],
  ['incorrect token decimals', { decimals: 18 }, /token information/],
]) test(`${name} is rejected before any approval`, async () => {
  const s = scenario(changes); await assert.rejects(s.run(), reason)
  assert.equal(s.writes.length, 0)
})
test('capacity is rechecked after approval', async () => {
  const s = scenario({ afterWrite: () => { globalThis.depositTest.capacity = 0n } })
  await assert.rejects(s.run(), /capacity/)
  assert.deepEqual(s.writes.map((w) => w.functionName), ['approve'])
})
test('account changes during approval stop the deposit', async () => {
  const s = scenario({ afterWrite: () => { globalThis.depositTest.account = address(99) } })
  await assert.rejects(s.run(), /account or network/)
  assert.deepEqual(s.writes.map((w) => w.functionName), ['approve'])
})
test('failed simulation does not request a deposit transaction', async () => {
  const s = scenario({ allowance: 1_000_000n, simulationFailure: true })
  await assert.rejects(s.run(), /simulation reverted/); assert.equal(s.writes.length, 0)
})
test('invalid, zero and overprecise amounts never reach a wallet', async () => {
  for (const value of ['0', '-1', '1e3', '1.2.3', '0.0000001', '1.0000001']) {
    const s = scenario(); await assert.rejects(s.run(value)); assert.equal(s.writes.length, 0)
  }
})
