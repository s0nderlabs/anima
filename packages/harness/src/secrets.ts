// Plaintext secrets the operator hands off to the harness alongside the
// agent privkey. Shipped via a second ECIES envelope sealed to the same
// bootstrap pubkey as the privkey envelope; harness verifies the operator's
// signature covers both before decrypting.
//
// Phase 12: telegram bot token + allowlist + pairing-approved users. Future
// platforms will extend the same shape (discord, slack, etc.).

import { z } from 'zod'

export const TelegramSecretsSchema = z.object({
  botToken: z.string().min(20),
  allowedUserIds: z.array(z.number().int().nonnegative()),
  pairingApproved: z.array(z.number().int().nonnegative()).optional(),
})

export const HarnessSecretsSchema = z.object({
  telegram: TelegramSecretsSchema.optional(),
})

export type TelegramSecrets = z.infer<typeof TelegramSecretsSchema>
export type HarnessSecrets = z.infer<typeof HarnessSecretsSchema>

export function parseHarnessSecrets(json: string): HarnessSecrets {
  return HarnessSecretsSchema.parse(JSON.parse(json))
}
