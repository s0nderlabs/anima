import { describe, expect, it } from 'bun:test'
import { VISION_PROVIDER_DEFAULTS } from './broker-pool'

describe('VISION_PROVIDER_DEFAULTS', () => {
  it('has the qwen3-vl mainnet provider hardcoded', () => {
    expect(VISION_PROVIDER_DEFAULTS['0g-mainnet']).toBe(
      '0x4415ef5CBb415347bb18493af7cE01f225Fc0868',
    )
  })

  it('has no testnet vision provider yet', () => {
    expect(VISION_PROVIDER_DEFAULTS['0g-testnet']).toBeNull()
  })
})
