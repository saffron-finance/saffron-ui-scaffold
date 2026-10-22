# Saffron UI Scaffold

A small, standalone React interface for Saffron variable-side vaults. Read live
contract state, browse vault capacity and Uniswap position ranges, connect an
injected browser wallet, and approve/deposit the vault's variable ERC-20 asset.
Every transaction is confirmed in the user's own wallet.

## Scope

A deliberately small contracts UI: live vault discovery, capacity/range views,
and explicit wallet-confirmed variable-side deposits. The static fixture is a
read-only visual example. No hosting automation or server-side signer is included.

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

Only verified active factories are enumerated; legacy factories and inactive
networks are not advertised as supported.

Reads use factory `nextVaultId()` / `vaultInfo(id)` and Multicall3. A network
mismatch, incomplete vault state or missing token metadata is an error, never a
zero balance. Uninitialized factory entries are omitted. See
[verification evidence](docs/VERIFICATION.md) for the tested blocks and limits.

## Run the live UI

Use Node.js 20.19+ (Node 22/24 also work).

```sh
npm ci --ignore-scripts
test -f .env || install -m 600 .env.example .env
# Set RPC_ROBINHOOD and any preferred server-side RPC providers in .env.
npm start
```

Open `http://127.0.0.1:3200/`. The normal build is **live**, not the static demo.
Ethereum, Arbitrum, Base and BNB have public read-RPC fallbacks; reliability and
rate limits depend on those providers. Robinhood requires your own RPC endpoint.
`PORT`, `BIND_HOST` and `BASE_PATH` can configure a deployment. Put HTTPS in front
of public deployments and preserve both asset and `/rpc/<chain>` routes.

`RPC_*` settings are read only by the Node relay in `server/rpc.mjs`; they
never enter frontend modules, in development or production. The relay accepts
allowlisted read methods only. Approvals and deposits go directly through the injected wallet, never through the relay.

**Robinhood wallet setup:** the wallet must already know chain 4663, or you must
add it using your RPC provider. No unverified public wallet RPC is invented or
private server endpoint disclosed. The read-only relay is not a wallet write RPC.

For local development, run `npm run dev` on port 5180. It uses the same server-only
`.env` and relay as production; no second server is needed. Vite environment
exposure is disabled. Remove old `VITE_RPC_*` settings and use `RPC_*` instead;
legacy browser-prefixed RPC settings deliberately fail startup.

## Operator security and visitor privacy

- Keep `.env` private (mode 600), ignored by Git, and outside `public/` and `dist/`.
  The relay accepts HTTPS or HTTP URLs without URL-userinfo authentication; use
  HTTPS for remote providers and provider-supported URL-path/query credentials.
- Provider HTTP errors, JSON-RPC errors, malformed responses and diagnostic
  extensions never pass through as free text. Errors are generic; valid Ethereum
  results are checked and response IDs must match the requests.
- Requests/responses, batch size, concurrency and upstream time are bounded.
  Redirects are rejected. Browser requests must be same-origin JSON POSTs.
- Both servers bind to loopback by default. For public hosting, configure HTTPS,
  authentication where appropriate, and per-client rate/billing limits at your
  reverse proxy/provider. The read relay is not an authenticated quota firewall:
  a non-browser client can still call an intentionally public deployment.
- The production server restricts assets/connections to its own origin, blocks
  framing and hidden files, and suppresses referrers. Keep these response headers
  when adding a reverse proxy. Set equivalent headers if serving the build with
  another static server.
- Fonts, network marks and available token logos are bundled locally. Unknown
  tokens use local monograms; the UI makes no font/icon-service requests.
  Font and image license/attribution files are retained in `public/`.
- RPC providers necessarily see chain queries. An injected wallet uses its own
  provider for account reads and transactions. Explorer links contact the chosen
  explorer only when followed. Public contract addresses and chain evidence are
  not credentials; wallet private keys must never be put in this repository.

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
