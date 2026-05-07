import { describe, expect, test } from 'bun:test'
import { runBalance } from './balance'

describe('anima balance command surface', () => {
  test('runBalance is exported and callable', () => {
    expect(typeof runBalance).toBe('function')
    // function signature: (opts: { agent?, cwd? }) → Promise<void>
    expect(runBalance.length).toBe(1)
  })
})
