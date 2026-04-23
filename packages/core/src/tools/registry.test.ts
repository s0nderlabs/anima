import { expect, test } from 'bun:test'
import { z } from 'zod'
import { ToolRegistry } from './registry'

test('register + find + dispatch a tool', async () => {
  const reg = new ToolRegistry()
  let captured: unknown = null
  reg.register({
    name: 'echo',
    description: 'Echo back a message',
    schema: z.object({ message: z.string() }),
    handler: async args => {
      captured = args
      return { ok: true, data: args }
    },
  })

  const r = await reg.dispatch({ id: 'c1', name: 'echo', args: { message: 'hi' } })
  expect(r.ok).toBe(true)
  expect(captured).toEqual({ message: 'hi' })
})

test('dispatch fails on unknown tool', async () => {
  const reg = new ToolRegistry()
  const r = await reg.dispatch({ id: 'c1', name: 'nope', args: {} })
  expect(r.ok).toBe(false)
})

test('dispatch fails on schema-invalid args', async () => {
  const reg = new ToolRegistry()
  reg.register({
    name: 'echo',
    description: 'Echo',
    schema: z.object({ message: z.string() }),
    handler: async () => ({ ok: true }),
  })
  const r = await reg.dispatch({ id: 'c1', name: 'echo', args: { message: 123 } })
  expect(r.ok).toBe(false)
  expect(r.error).toContain('Invalid args')
})

test('glob disable prevents dispatch', async () => {
  const reg = new ToolRegistry({ 'defi.*': false })
  reg.register({
    name: 'defi.swap',
    description: 'Swap',
    schema: z.object({}),
    handler: async () => ({ ok: true }),
  })
  expect(reg.find('defi.swap')).toBeUndefined()
  const r = await reg.dispatch({ id: 'c1', name: 'defi.swap', args: {} })
  expect(r.ok).toBe(false)
  expect(r.error).toContain('Unknown tool')
})

test('schemas() emits OpenAI-compat shape', () => {
  const reg = new ToolRegistry()
  reg.register({
    name: 'memory.save',
    description: 'Save memory',
    schema: z.object({ name: z.string(), type: z.enum(['feedback', 'user']) }),
    handler: async () => ({ ok: true }),
  })
  const schemas = reg.schemas()
  expect(schemas[0]!.type).toBe('function')
  expect(schemas[0]!.function.name).toBe('memory.save')
  const props = schemas[0]!.function.parameters.properties as Record<string, { type: string }>
  expect(props.name).toEqual({ type: 'string' })
  expect(schemas[0]!.function.parameters.required).toEqual(['name', 'type'])
})
