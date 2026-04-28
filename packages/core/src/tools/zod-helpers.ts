import { z } from 'zod'

/**
 * Some 0G Compute providers (qwen3.6-plus among them) serialize tool-call
 * boolean args as the strings "true"/"false" instead of JSON booleans. This
 * accepts either form and falls back to actual booleans + 0/1 numbers.
 */
export const coerceBool: z.ZodType<boolean> = z.preprocess(v => {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const lower = v.trim().toLowerCase()
    if (lower === 'true' || lower === '1' || lower === 'yes') return true
    if (lower === 'false' || lower === '0' || lower === 'no') return false
  }
  return v
}, z.boolean()) as unknown as z.ZodType<boolean>

/**
 * Same shape as coerceBool but for integers. qwen3.6-plus and other 0G
 * Compute providers sometimes serialize numeric tool-call args as strings
 * ("400" instead of 400). zod's z.number() rejects them with
 * "Expected number, received string". Wrap any numeric tool arg with
 * `coerceInt` (or `coerceInt.refine(n => n > 0, 'must be positive')`) so the
 * validation passes regardless of how the brain stringifies it.
 */
export const coerceInt: z.ZodType<number> = z.preprocess(v => {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (trimmed === '') return v
    const n = Number(trimmed)
    if (Number.isFinite(n) && Math.trunc(n) === n) return n
  }
  return v
}, z.number().int()) as unknown as z.ZodType<number>
