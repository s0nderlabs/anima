import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeCalldata } from './analysis'

describe('decodeCalldata', () => {
  test('local hit: ERC20 transfer decodes to {to, amount}', async () => {
    // transfer(address,uint256) selector 0xa9059cbb
    // recipient = 0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec
    // amount = 12345 (0x3039)
    const data =
      '0xa9059cbb000000000000000000000000c635e6eb223ae14143e23ceea9440bc773dc87ec0000000000000000000000000000000000000000000000000000000000003039' as `0x${string}`
    const dir = mkdtempSync(join(tmpdir(), 'anima-analysis-test-'))
    const decoded = await decodeCalldata({ data, agentDir: dir })
    expect('name' in decoded).toBe(true)
    if ('name' in decoded) {
      expect(decoded.name).toBe('transfer')
      expect(decoded.source).toBe('local')
      expect(decoded.args.length).toBe(2)
      expect((decoded.args[0] as string).toLowerCase()).toBe(
        '0xc635e6eb223ae14143e23ceea9440bc773dc87ec',
      )
      expect((decoded.args[1] as bigint).toString()).toBe('12345')
    }
  })

  test('local hit: WETH9 deposit (no args)', async () => {
    const data = '0xd0e30db0' as `0x${string}` // deposit() selector
    const dir = mkdtempSync(join(tmpdir(), 'anima-analysis-test-'))
    const decoded = await decodeCalldata({ data, agentDir: dir })
    expect('name' in decoded).toBe(true)
    if ('name' in decoded) {
      expect(decoded.name).toBe('deposit')
      expect(decoded.source).toBe('local')
    }
  })

  test('empty data falls into unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'anima-analysis-test-'))
    const decoded = await decodeCalldata({ data: '0x' as `0x${string}`, agentDir: dir })
    expect('source' in decoded && decoded.source === 'unknown').toBe(true)
  })
})
