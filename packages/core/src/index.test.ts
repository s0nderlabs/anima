import { expect, test } from 'bun:test'
import { VERSION } from './index'

test('core package loads and exposes VERSION', () => {
  expect(VERSION).toBe('0.0.0')
})
