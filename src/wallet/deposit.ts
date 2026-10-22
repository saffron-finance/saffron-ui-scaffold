import { encodeAbiParameters, parseUnits, type Address, type Hash } from 'viem'
import { walletClient, walletPublicClient, ensureChain } from './wallet'
import { CHAINS } from '../chain/chains'
import { vaultAbi } from '../chain/abis'
import { type VariableVault } from '../chain/vaults'

// Minimal token interface; approvals always target the selected vault only.
const erc20 = [
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const

export const vaultDepositAbi = [
  { name: 'deposit', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }], outputs: [] },
] as const

const VARIABLE_SIDE = 1n
export type DepositStep = 'switch-chain' | 'checking' | 'approving' | 'approve-confirm' | 'depositing' | 'deposit-confirm' | 'done'
export interface DepositResult { hash: Hash }

/**
 * Deposit an exact human-readable ERC-20 amount into a live variable-side vault.
 * Every write uses the injected wallet and requires its user's confirmation.
 * Fresh contract reads and simulation reject stale rows; reverted receipts never
 * become success. This function does not use a server signer or the read relay.
 */
export async function depositVariable(
  v: VariableVault,
  amountHuman: string,
  account: Address,
  onStep: (s: DepositStep) => void,
): Promise<DepositResult> {
  const chainDef = CHAINS.find((c) => c.key === v.chainKey)
  if (!chainDef) throw new Error(`Unknown chain ${v.chainKey}`)
  if (v.isStarted || v.earningsSettled) throw new Error('This vault is no longer open for deposits.')
  // parseUnits rounds excess decimal places. Reject them instead of silently
  // changing the user's amount, including sub-unit dust amounts.
  if (!/^\d+(?:\.\d*)?$/.test(amountHuman) || (amountHuman.split('.')[1]?.length ?? 0) > v.variableAssetDecimals) {
    throw new Error(`Enter an amount with at most ${v.variableAssetDecimals} decimal places.`)
  }
  const amount = parseUnits(amountHuman, v.variableAssetDecimals)
  if (amount <= 0n) throw new Error('Enter an amount greater than 0.')

  onStep('switch-chain')
  await ensureChain(chainDef.chain)
  const pub = walletPublicClient(chainDef.chain)
  const wc = walletClient()

  /** Refuse an account/network changed while a wallet prompt was open. */
  async function assertWallet() {
    const [addresses, chainId] = await Promise.all([wc.getAddresses(), wc.getChainId()])
    if (addresses[0]?.toLowerCase() !== account.toLowerCase() || chainId !== chainDef!.chain.id) {
      throw new Error('Wallet account or network changed. Reconnect and retry.')
    }
  }

  /** Re-read the contract, not the cached table, before any token approval. */
  async function assertOpenCapacity() {
    const [started, settled, capacity, asset, bearer, decimals] = await Promise.all([
      pub.readContract({ address: v.vault, abi: vaultAbi, functionName: 'isStarted' }),
      pub.readContract({ address: v.vault, abi: vaultAbi, functionName: 'earningsSettled' }),
      pub.readContract({ address: v.vault, abi: vaultAbi, functionName: 'variableSideCapacity' }),
      pub.readContract({ address: v.vault, abi: vaultAbi, functionName: 'variableAsset' }),
      pub.readContract({ address: v.vault, abi: vaultAbi, functionName: 'variableBearerToken' }),
      pub.readContract({ address: v.variableAsset, abi: erc20, functionName: 'decimals' }),
    ])
    if (started || settled) throw new Error('This vault is no longer open for deposits.')
    if (asset.toLowerCase() !== v.variableAsset.toLowerCase() || bearer.toLowerCase() !== v.variableBearer.toLowerCase() || decimals !== v.variableAssetDecimals) {
      throw new Error('Vault token information changed. Refresh before depositing.')
    }
    const deposited = await pub.readContract({ address: bearer, abi: erc20, functionName: 'totalSupply' })
    if (amount > capacity - deposited) throw new Error('Amount exceeds the current available vault capacity.')
  }

  /** Wait for an actual successful receipt, not merely a mined transaction. */
  async function confirmed(hash: Hash, action: string) {
    const receipt = await pub.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`${action} reverted. No deposit was confirmed.`)
  }

  onStep('checking')
  await assertWallet()
  await assertOpenCapacity()
  const [balance, allowance] = await Promise.all([
    pub.readContract({ address: v.variableAsset, abi: erc20, functionName: 'balanceOf', args: [account] }),
    pub.readContract({ address: v.variableAsset, abi: erc20, functionName: 'allowance', args: [account, v.vault] }),
  ])
  if (balance < amount) throw new Error(`Insufficient ${v.variableAssetSymbol} balance in your wallet.`)

  /** Zero-first approvals support tokens such as USDT without infinite spend. */
  async function approve(value: bigint) {
    await assertWallet()
    onStep('approving')
    const hash = await wc.writeContract({ account, chain: chainDef!.chain, address: v.variableAsset, abi: erc20, functionName: 'approve', args: [v.vault, value] })
    onStep('approve-confirm')
    await confirmed(hash, 'Token approval')
  }
  if (allowance < amount) {
    if (allowance > 0n) await approve(0n)
    await approve(amount)
  }

  await assertWallet()
  await assertOpenCapacity()
  // The deployed contract supports a minimum amount in this bytes argument.
  // Requiring the exact amount prevents a competing deposit from silently
  // reducing our fill between simulation and inclusion in a block.
  const minimum = encodeAbiParameters([{ type: 'uint256' }], [amount])
  const { request } = await pub.simulateContract({
    account, address: v.vault, abi: vaultDepositAbi, functionName: 'deposit',
    args: [amount, VARIABLE_SIDE, minimum],
  })
  await assertWallet()
  onStep('depositing')
  const hash = await wc.writeContract({ ...request, account, chain: chainDef.chain })
  onStep('deposit-confirm')
  await confirmed(hash, 'Deposit')
  onStep('done')
  return { hash }
}
