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
