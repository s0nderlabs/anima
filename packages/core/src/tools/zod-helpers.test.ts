import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { coerceBool } from './zod-helpers'
import { zodToJsonSchema } from './zod-schema'

describe('coerceBool', () => {
  it('accepts native booleans', () => {
    expect(coerceBool.parse(true)).toBe(true)
    expect(coerceBool.parse(false)).toBe(false)
  })

  it('coerces "true"/"false" strings (qwen3.6-plus quirk)', () => {
    expect(coerceBool.parse('true')).toBe(true)
    expect(coerceBool.parse('True')).toBe(true)
    expect(coerceBool.parse('false')).toBe(false)
    expect(coerceBool.parse('False')).toBe(false)
  })

  it('coerces 0/1 + yes/no', () => {
    expect(coerceBool.parse(1)).toBe(true)
    expect(coerceBool.parse(0)).toBe(false)
    expect(coerceBool.parse('yes')).toBe(true)
    expect(coerceBool.parse('no')).toBe(false)
  })

  it('rejects garbage', () => {
    expect(() => coerceBool.parse('maybe')).toThrow()
    expect(() => coerceBool.parse({})).toThrow()
  })

  it('zodToJsonSchema unwraps to type:boolean', () => {
    const schema = z.object({ flag: coerceBool.optional() })
    const json = zodToJsonSchema(schema)
    expect((json.properties.flag as { type: string }).type).toBe('boolean')
  })
})
