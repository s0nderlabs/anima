import type { z } from 'zod'
import type { JSONSchema } from './types'

/**
 * Convert a zod object schema to the minimal JSON Schema dialect 0G Compute
 * (and the OpenAI tool-calling format) expects. Handles: string, number,
 * boolean, enum, optional, array, nested object. Good enough for phase 1-3
 * MVP tools; revisit when we need deeper schema features.
 */
export function zodToJsonSchema(schema: z.ZodType, description?: string): JSONSchema {
  const shape = unwrapObjectShape(schema)
  if (!shape) throw new Error('Top-level tool schema must be a z.object({ ... })')
  return objectShapeToJson(shape, description) as unknown as JSONSchema
}

type ZodObjectLike = { _def: { typeName: string; shape: () => Record<string, z.ZodType> } }

function unwrapObjectShape(schema: z.ZodType): Record<string, z.ZodType> | null {
  const s = schema as unknown as ZodObjectLike
  if (s._def?.typeName === 'ZodObject') return s._def.shape()
  return null
}

function unwrapOptional(schema: z.ZodType): { schema: z.ZodType; optional: boolean } {
  const s = schema as unknown as {
    _def: { typeName: string; innerType?: z.ZodType; schema?: z.ZodType }
  }
  if (s._def?.typeName === 'ZodOptional' || s._def?.typeName === 'ZodDefault') {
    return { schema: s._def.innerType!, optional: true }
  }
  if (s._def?.typeName === 'ZodEffects') {
    const inner = unwrapOptional(s._def.schema!)
    return inner
  }
  return { schema, optional: false }
}

function objectShapeToJson(
  shape: Record<string, z.ZodType>,
  description?: string,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, value] of Object.entries(shape)) {
    const { schema: prop, optional } = unwrapOptional(value)
    properties[key] = zodTypeToJson(prop)
    if (!optional) required.push(key)
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
    ...(description ? { description } : {}),
  }
}

function zodTypeToJson(schema: z.ZodType): unknown {
  const s = schema as unknown as {
    _def: {
      typeName: string
      description?: string
      values?: string[]
      type?: z.ZodType
      shape?: () => Record<string, z.ZodType>
    }
  }
  const t = s._def.typeName
  const description = s._def.description

  switch (t) {
    case 'ZodString':
      return { type: 'string', ...(description ? { description } : {}) }
    case 'ZodNumber':
      return { type: 'number', ...(description ? { description } : {}) }
    case 'ZodBoolean':
      return { type: 'boolean', ...(description ? { description } : {}) }
    case 'ZodEnum':
      return {
        type: 'string',
        enum: s._def.values,
        ...(description ? { description } : {}),
      }
    case 'ZodArray':
      return {
        type: 'array',
        items: zodTypeToJson(s._def.type!),
        ...(description ? { description } : {}),
      }
    case 'ZodObject':
      return objectShapeToJson(s._def.shape?.() ?? {}, description)
    case 'ZodEffects': {
      const inner = (s._def as unknown as { schema: z.ZodType }).schema
      return zodTypeToJson(inner)
    }
    default:
      return { description: description ?? 'unspecified' }
  }
}
