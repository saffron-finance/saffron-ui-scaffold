# Verification — 2026-10-22

## Scope and provenance

- UI source: Saffron Scaffold `84e98ce0b978b525b8ed59a57ed21a05a157c08e` (September 2).
- Network deployment metadata was checked against the pre-September-3 protocol configuration at `9f112e611` and against deployed bytecode.
- This repository has new history. No later source trees were merged or cherry-picked.
- The read relay is required to protect RPC credentials. No transaction signing service, database or host configuration is included.

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
- 23 regression tests passed: transaction coordination, exact calldata,
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
- The read relay validates JSON-RPC requests, bounds upstream time, and rejects malformed paths.

## Operational limits

- Robinhood reads require an operator-provided RPC; the wallet must also know chain 4663.
- The static fixture is from September 1 and is a visual demo only.
- Only the five listed active factories are supported. Archived/inactive networks and legacy factories are not promised.
- No site or existing service was redeployed.
