import { defineChain, type Chain } from 'viem'
import { mainnet, arbitrum, base, bsc } from 'viem/chains'

// Robinhood Chain is an Arbitrum-Orbit L2 (chain id 4663). viem has no built-in def, so we declare it.
// Native currency + explorer taken from Saffron's config / the public Blockscout instance.
export const robinhoodChain: Chain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    // The wallet must supply its own chain RPC; application reads use the local relay.
    default: { http: [] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
  // Multicall3 is deployed at the canonical address (verified on-chain). viem ships it for
  // mainnet/arbitrum but not for this custom chain, so we declare it to enable batched reads.
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
})

export type ChainKey = 'ethereum' | 'arbitrum' | 'base' | 'bnb' | 'robinhood'

export interface ChainDef {
  key: ChainKey
  label: string
  chain: Chain
  // Every factory to enumerate on this chain: the active one plus any legacy factories that still hold vaults.
  factories: `0x${string}`[]
  explorer: string
}

// Keep this registry explicit: each entry is the single supported factory for its chain.
export const CHAINS: ChainDef[] = [
  {
    key: 'ethereum',
    label: 'Ethereum',
    chain: mainnet,
    factories: ['0x7fE802B891734DB681b7353bFF9E6c85ce0ab200'],
    explorer: 'https://etherscan.io',
  },
  {
    key: 'arbitrum',
    label: 'Arbitrum',
    chain: arbitrum,
    factories: ['0xd4E8582e36AF0E0d5c1bcd8303984870b086d3d2'], // active
    explorer: 'https://arbiscan.io',
  },
  {
    key: 'base',
    label: 'Base',
    chain: base,
    // Deployment recorded before the September 2 UI snapshot; checked onchain.
    factories: ['0xd4E8582e36AF0E0d5c1bcd8303984870b086d3d2'],
    explorer: 'https://basescan.org',
  },
  {
    key: 'bnb',
    label: 'BNB Chain',
    chain: bsc,
    factories: ['0x9b99ffb478894f165b0d849614d8f440469bc01a'],
    explorer: 'https://bscscan.com',
  },
  {
    key: 'robinhood',
    label: 'Robinhood Chain',
    chain: robinhoodChain,
    factories: ['0xb24b143ad6bB5bE9559CcC75f34A2261b7456904'], // active (RestrictedVaultFactory)
    explorer: 'https://robinhoodchain.blockscout.com',
  },
]

// The numeric chain id for a chain key (used for token-logo lookups by (chainId, address)).
export function chainIdFor(key: ChainKey): number {
  return CHAINS.find((c) => c.key === key)?.chain.id ?? 0
}

/** Always use the same-origin server relay, including during local development. */
export function rpcFor(def: ChainDef): string {
  return new URL(`rpc/${def.key}`, document.baseURI).toString()
}
