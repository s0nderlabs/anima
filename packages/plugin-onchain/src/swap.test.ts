import { describe, expect, test } from 'bun:test'
import { getAddress } from 'viem'
import {
  type ExactInputSingleParams,
  composeSwap,
  encodeExactInputSingle,
  encodeRefundETH,
  encodeUnwrapWETH9,
} from './swap'

const ROUTER = getAddress('0x8B598A7C136215A95ba0282b4d832B9f9801f2e2')
const W0G = getAddress('0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c')
const USDCE = getAddress('0x1f3aa82227281ca364bfb3d253b0f1af1da6473e')

const sampleParams: ExactInputSingleParams = {
  tokenIn: W0G,
  tokenOut: USDCE,
  fee: 3000,
  recipient: getAddress('0x1e930c1647EaB93651FD94e760E0cbbb5F4FC99f'),
  deadline: 1_700_000_000n,
  amountIn: 10n ** 16n,
  amountOutMinimum: 0n,
  sqrtPriceLimitX96: 0n,
}

describe('encodeExactInputSingle', () => {
  test('emits 0x414bf389 selector (verified mainnet selector)', () => {
    const hex = encodeExactInputSingle(sampleParams)
    expect(hex.startsWith('0x414bf389')).toBe(true)
  })

  test('different params produce different calldata', () => {
    const a = encodeExactInputSingle(sampleParams)
    const b = encodeExactInputSingle({ ...sampleParams, amountIn: 10n ** 17n })
    expect(a).not.toBe(b)
  })
})

describe('encodeRefundETH', () => {
  test('emits 0x12210e8a selector', () => {
    expect(encodeRefundETH()).toBe('0x12210e8a')
  })
})

describe('encodeUnwrapWETH9', () => {
  test('selector + recipient encoding', () => {
    const hex = encodeUnwrapWETH9(0n, sampleParams.recipient)
    expect(hex.startsWith('0x49404b7c')).toBe(true)
    expect(hex.length).toBe(2 + 4 * 2 + 32 * 2 * 2) // 4-byte selector + 2 × 32-byte args
  })
})

describe('composeSwap', () => {
  test('ERC-20 ↔ ERC-20: direct exactInputSingle (value=0)', () => {
    const out = composeSwap({
      params: sampleParams,
      nativeIn: false,
      nativeOut: false,
      router: ROUTER,
    })
    expect(out.value).toBe(0n)
    expect(out.data.startsWith('0x414bf389')).toBe(true)
    expect(out.to).toBe(ROUTER)
  })

  test('native IN: multicall + value=amountIn', () => {
    const out = composeSwap({
      params: sampleParams,
      nativeIn: true,
      nativeOut: false,
      router: ROUTER,
    })
    expect(out.value).toBe(sampleParams.amountIn)
    // Multicall selector is `0xac9650d8` (multicall(bytes[]))
    expect(out.data.startsWith('0xac9650d8')).toBe(true)
  })

  test('native OUT: multicall + value=0 + unwrapWETH9 chained', () => {
    const out = composeSwap({
      params: sampleParams,
      nativeIn: false,
      nativeOut: true,
      router: ROUTER,
    })
    expect(out.value).toBe(0n)
    expect(out.data.startsWith('0xac9650d8')).toBe(true)
    // Inner data should contain the unwrapWETH9 selector (0x49404b7c)
    expect(out.data.includes('49404b7c')).toBe(true)
  })

  test('rejects nativeIn AND nativeOut', () => {
    expect(() =>
      composeSwap({
        params: sampleParams,
        nativeIn: true,
        nativeOut: true,
        router: ROUTER,
      }),
    ).toThrow(/not supported/)
  })
})
