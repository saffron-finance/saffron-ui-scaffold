# Saffron UI Scaffold

A small, standalone React interface for Saffron variable-side vaults. Read live
contract state, browse vault capacity and Uniswap position ranges, connect an
injected browser wallet, and approve/deposit the vault's variable ERC-20 asset.
Every transaction is confirmed in the user's own wallet.

## Source boundary

Fresh repository history based on the September 2, 2026 Saffron Scaffold tree
`84e98ce0b978b525b8ed59a57ed21a05a157c08e`. No later source tree or Git history is
imported. The original interface and September 1 static fixture are retained.
Changes are limited to verified Base/BNB network support, chain-specific range
keys, deposit correctness, read-relay validation, tests, and these instructions.
Original one-off diagnostics and hosting automation are not included.

This remains a **variable-side deposit UI**, not a fixed-side deposit interface.
The variable premium buys the right to LP fees; it is not principal that is
simply returned at maturity. There is no backend transaction signer or database.

## Verified networks

| Network | Chain ID | Active Saffron factory |
|---|---:|---|
| Ethereum | 1 | `0x7fE802B891734DB681b7353bFF9E6c85ce0ab200` |
| Arbitrum | 42161 | `0xd4E8582e36AF0E0d5c1bcd8303984870b086d3d2` |
| Base | 8453 | `0xd4E8582e36AF0E0d5c1bcd8303984870b086d3d2` |
| BNB Chain | 56 | `0x9b99ffb478894f165b0d849614d8f440469bc01a` |
| Robinhood Chain | 4663 | `0xb24b143ad6bB5bE9559CcC75f34A2261b7456904` |

These factory addresses were already recorded in Saffron's pre-September-3
configuration. Only verified active factories are enumerated; legacy factories
and inactive networks are not advertised as supported.

Reads use factory `nextVaultId()` / `vaultInfo(id)` and Multicall3. A network
mismatch, incomplete vault state or missing token metadata is an error, never a
zero balance. Uninitialized factory entries are omitted. See
[verification evidence](docs/VERIFICATION.md) for the tested blocks and limits.

## Run the live UI

Use Node.js 20.19+ (Node 22/24 also work).

```sh
npm ci --ignore-scripts
cp .env.example .env
# Set RPC_ROBINHOOD and any preferred server-side RPC providers in .env.
npm start
```

Open `http://127.0.0.1:3200/`. The normal build is **live**, not the static demo.
Ethereum, Arbitrum, Base and BNB have public read-RPC fallbacks; reliability and
rate limits depend on those providers. Robinhood requires your own RPC endpoint.
`PORT`, `BIND_HOST` and `BASE_PATH` can configure a deployment. Put HTTPS in front
of public deployments and preserve both asset and `/rpc/<chain>` routes.

`RPC_*` settings are read only by `server/proxy.mjs`; they never enter the
frontend bundle. The relay accepts allowlisted read methods only. Approvals and
deposits go directly through the injected wallet, never through the relay.

**Robinhood wallet setup:** the wallet must already know chain 4663, or you must
add it using your RPC provider. No unverified public wallet RPC is invented or
private server endpoint disclosed. The read-only relay is not a wallet write RPC.

For local frontend development, run `npm run dev` on port 5180. The optional
`VITE_RPC_*` settings are for local development only and are visible in that
browser; keep authenticated URLs out of shared development servers.

## Deposit behavior

- Check the selected wallet account/network and re-read contract lifecycle,
  token identity/decimals, available capacity, balance and allowance.
- Request only the required approval; reset an insufficient nonzero allowance
  first for tokens that require zero-first approvals.
- Recheck state after approval and simulate the deposit before requesting a
  signature. Require successful approval and deposit receipts.
- Call `deposit(amount, 1, abi.encode(amount))`. Side 1 is the variable side;
  the encoded minimum prevents silent partial filling if capacity changes.
- Reject invalid precision, changed accounts/networks and stale capacities.

A working connection does not guarantee every vault is open or that a wallet has
sufficient tokens, approval and gas. Successful simulation is not a mined receipt.

## Static UI demo and checks

```sh
npm run build
npm test
npm run build:mock
npm run preview
```

`build:mock` uses the original committed onchain snapshot, makes no RPC reads,
and disables all wallet actions. It is a visual demo, not current mainnet data.
Run `npm run build` again before serving a live production UI.

No automatic site deployment is included. See [AGENTS.md](AGENTS.md) before
editing and [server/AGENTS.md](server/AGENTS.md) for the read-relay boundary.
