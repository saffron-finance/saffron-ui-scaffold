# Verification and security boundaries

## Scope

This is the minimal variable-side contracts UI. The supported factory metadata
has been checked against deployed bytecode. The read relay protects provider
configuration; no transaction-signing service, database or host-specific setup
is included. Pinned chain evidence below is historical verification, not a claim
that every vault remains open today.

## Actual application reads

The bundled application loader and range reader were executed against live mainnets through this repository's read relay. It loaded **298 initialized vaults and 298 chain-qualified ranges**, with no loader errors. Five Ethereum factory entries are uninitialized and deliberately omitted.

| Network | Chain ID | Initialized vaults | Open capacity | Read probe block |
|---|---:|---:|---:|---:|
| ethereum | 1 | 93 | 42 | 26247718 |
| arbitrum | 42161 | 64 | 32 | 517204538 |
| base | 8453 | 5 | 1 | 52938762 |
| bnb | 56 | 5 | 2 | 129118354 |
| robinhood | 4663 | 131 | 54 | 95061783 |

Enumeration/range reads use the application's live/latest semantics, not a single atomic cross-chain snapshot. Factory bytecode hashes and ABI probes were pinned to the reported per-chain block. Counts change as contracts change. Full block hashes and factory code hashes are in [mainnet-evidence.json](mainnet-evidence.json).

## Positive deposit simulations

On each network, a read-only `eth_call` executed token approval followed by
`deposit(1, 1, abi.encode(uint256(1)))` against a real open vault. The amount is
**one base unit**, not one whole token. All five calls succeeded: the caller's
variable-asset balance decreased by one and its real bearer-token balance
increased by one. This covers the non-filling deposit path.

| Network | Pinned block | Token | Decimals | Result |
|---|---:|---|---:|---|
| ethereum | 26247732 | USDT | 6 | token −1; bearer +1 |
| arbitrum | 517205127 | WETH | 18 | token −1; bearer +1 |
| base | 52938844 | USDC | 6 | token −1; bearer +1 |
| bnb | 129118719 | WBNB | 18 | token −1; bearer +1 |
| robinhood | 95063416 | USDG | 6 | token −1; bearer +1 |

**Simulation boundary:** an existing funded address had its runtime code
overridden with a temporary call harness for that `eth_call` only. The target
vault and ERC-20 contracts were not replaced; their balances, allowance logic
and minting behavior were executed by the real deployed code. Where the caller
was a pool, only that caller's runtime was overridden, not its storage.
No test key, persistent state change, real approval, deployment or transaction
broadcast occurred. This is not proof of an unmodified funded wallet transaction,
full-capacity auto-start, withdrawals, settlement or every token/vault combination.

The matching calls from an unfunded/unapproved account reverted at the token
transfer/allowance checks, as expected. On Robinhood, `0x13be252b` decodes as
`InsufficientAllowance()`. A selector alone was not treated as a successful deposit.

## Application checks

- Clean lockfile installation with package lifecycle scripts disabled.
- TypeScript/Vite live build passed.
- Transaction regression tests cover: transaction coordination, exact calldata,
  zero-first approvals, reverted receipts, stale state, account/network changes,
  chain-qualified ranges, and read-relay rejection cases.
- Live and static builds passed Chromium checks at 1440px and 390px, with no script errors or horizontal overflow.
- Live Base wallet flow switched to chain 8453, read contract state and requested the exact USDC approval; the scripted provider rejected the request before any broadcast. This was not a real-wallet signing test.
- Static preview filters and deposit-modal feedback passed with zero RPC requests and zero wallet accesses.
- No fork node was used or started.

## Compatibility fixes

- Base and BNB use verified active factory addresses; the original three networks remain.
- Five actual Base vault addresses also exist on Arbitrum. Range keys now include the chain, preventing data from one network being shown on another.
- Failed reads cannot masquerade as open capacity or token balances.
- The wallet path checks current identity, capacity, token metadata and receipts.
- Exact minimum-amount calldata rejects competing partial fills; existing nonzero allowances are cleared before a replacement approval.
- The shared development/production relay validates requests and results, correlates batch IDs, bounds resources and strips upstream diagnostics.

## Operational limits

- Robinhood reads require an operator-provided RPC; the wallet must also know chain 4663.
- The static fixture is from September 1 and is a visual demo only.
- Only the five listed active factories are supported. Archived/inactive networks and legacy factories are not promised.
- No site or existing service was redeployed.

## Credential-isolation and privacy regression checks

- Fake credentials in HTTP errors, JSON-RPC errors, diagnostic fields, invalid
  success payloads and redirects cannot reach browser-facing relay responses.
- Oversized replies, unknown/duplicate IDs, oversized batches, cross-site requests
  and non-JSON POSTs fail closed. Real successful reads and out-of-order batches
  remain supported.
- An isolated Vite fixture proves server-only `.env` reads work, arbitrary
  `VITE_*` values are not exposed in modules, sensitive paths are denied, and
  legacy `VITE_RPC_*` configuration fails without disclosing its value.
- Production and static builds use local fonts/icons. Browser checks verify no
  automatic cross-origin resource requests. Mock mode remains RPC/wallet-free.
- These checks use disposable test endpoints and fake values, never live signing
  keys. No test performs a mainnet write or starts a fork node.

## Dependency security baseline

The lockfile updates development tooling to Vite 6.4.5, esbuild 0.25.12 and
source-map-js 1.2.2 to address the advisories affecting the earlier versions.
Use the committed lockfile with `npm ci --ignore-scripts`. Run `npm audit` when
updating dependencies; an audit result reflects the registry's current advisory
set, not a guarantee against unknown vulnerabilities.

Final hardening verification: **40 tests passed**, both build modes passed,
production/mock Chromium flows passed at desktop and mobile sizes, and neither
flow issued an automatic cross-origin resource request. The live loader still
read **298 initialized vaults and 298 ranges** across all five chains. Fake
server/browser-prefixed RPC settings were absent from both generated builds.
The clean lockfile install passed and `npm audit` reported **zero known
vulnerabilities** in that dependency tree at verification time.
