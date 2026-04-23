/**
 * Threat-pattern scan applied to every write. Content that matches any
 * pattern is rejected — this file IS a memory file that gets injected into
 * the brain's prompt, so malicious content = persistent prompt injection.
 *
 * MVP list (extend over time).
 */
const PATTERNS: Array<{ id: string; regex: RegExp; reason: string }> = [
  {
    id: 'ignore-previous-instructions',
    regex: /ignore (all |any |previous |prior )?instructions/i,
    reason: 'Prompt injection attempt (ignore-instructions directive).',
  },
  {
    id: 'role-override',
    regex: /you are (now |actually |a )[^.\n]{3,80}/i,
    reason: 'Prompt injection attempt (role override).',
  },
  {
    id: 'system-prompt-request',
    regex: /(print|show|reveal|output) (your|the) (system )?prompt/i,
    reason: 'Prompt injection attempt (system-prompt exfil).',
  },
  {
    id: 'private-key-dump',
    regex: /(private|secret) key is ([0-9a-f]{32,}|0x[0-9a-f]{40,})/i,
    reason: 'Suspicious private-key literal in memory content.',
  },
  {
    id: 'invisible-unicode',
    // Explicit alternation to avoid ZWJ-composed character classes that
    // biome's noMisleadingCharacterClass rule flags. Covers zero-width
    // space, joiner variants, BOM, and Unicode bidi override markers.
    regex: /​|‌|‍|﻿|⁠|‪|‫|‬|‭|‮/u,
    reason: 'Invisible unicode detected (possible hidden instruction).',
  },
  {
    id: 'transfer-claim',
    regex: /transfer.*(inft|agent).*(without|bypass|skip).*(tee|verification|signature)/i,
    reason: 'Suspicious transfer/TEE-bypass claim.',
  },
  {
    id: 'exfil-sink',
    regex:
      /(curl|fetch|wget|nc) [^\n]{10,}[@:.]([a-z0-9.-]+\.(?!(0g|anima|s0nderlabs|local|localhost|127\.0\.0\.1))[a-z]{2,})/i,
    reason: 'Command-line exfiltration pattern in memory content.',
  },
]

export interface ThreatScanResult {
  ok: boolean
  violations: Array<{ id: string; reason: string }>
}

export function scanForThreats(content: string): ThreatScanResult {
  const violations: Array<{ id: string; reason: string }> = []
  for (const p of PATTERNS) {
    if (p.regex.test(content)) {
      violations.push({ id: p.id, reason: p.reason })
    }
  }
  return { ok: violations.length === 0, violations }
}
