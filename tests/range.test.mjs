import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

// Replace the network client boundary; range keys are pure UI identities.
const bundle = await build({entryPoints:['src/chain/fixedRange.ts'],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'no-network',setup(builder){builder.onLoad({filter:/\/chain\/clients\.ts$/},()=>({contents:'export const clientFor = () => undefined',loader:'js'}))}}]})
const {vaultRangeKey}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
test('same deployed address on Base and Arbitrum never aliases',()=>{
  const vault='0x53A352C9b16F78Fd0B374D03E2c4cA8842bDEb2D'
  const base=vaultRangeKey({chainKey:'base',vault})
  const arbitrum=vaultRangeKey({chainKey:'arbitrum',vault})
  assert.notEqual(base,arbitrum)
  const ranges=new Map([[base,'WETH/USDC'],[arbitrum,'ARB/DAI']])
  assert.equal(ranges.get(base),'WETH/USDC')
  assert.equal(ranges.get(arbitrum),'ARB/DAI')
  assert.equal(base,vaultRangeKey({chainKey:'base',vault:vault.toLowerCase()}))
})
