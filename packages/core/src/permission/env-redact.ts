/**
 * Redact secrets-bearing env vars before passing process.env to a shell
 * subprocess. Mirrors hermes' env passthrough policy: API keys, wallet
 * material, and provider creds never leak to a child process the brain
 * controls. The brain may still need PATH, HOME, SHELL, LANG, TERM, etc.
 */

const ALWAYS_DENY: RegExp[] = [
  /^ANIMA_(OPERATOR|AGENT)_PRIVKEY/i,
  /^ANIMA_KEYCHAIN/i,
  /^ANIMA_TEST_AGENT_PRIVKEY/i,
  /^OPENAI_API_KEY$/i,
  /^ANTHROPIC_API_KEY$/i,
  /^GOOGLE_API_KEY$/i,
  /^GEMINI_API_KEY$/i,
  /^GROQ_API_KEY$/i,
  /^AZURE_OPENAI_API_KEY$/i,
  /^DEEPSEEK_API_KEY$/i,
  /^MISTRAL_API_KEY$/i,
  /^TOGETHER_API_KEY$/i,
  /^XAI_API_KEY$/i,
  /^GH_TOKEN$/i,
  /^GITHUB_TOKEN$/i,
  /^GITLAB_TOKEN$/i,
  /^NPM_TOKEN$/i,
  /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$/i,
  /^GCP_/i,
  /^GOOGLE_APPLICATION_CREDENTIALS$/i,
  /^OG_(PRIVKEY|PRIVATE_KEY|MNEMONIC)/i,
  /_(PRIVKEY|PRIVATE_KEY|SECRET|MNEMONIC|API_KEY|AUTH_TOKEN)$/i,
  /^DATABASE_URL$/i,
  /^TELEGRAM_BOT_TOKEN$/i,
  /^DISCORD_BOT_TOKEN$/i,
  /^STRIPE_SECRET_KEY$/i,
]

export interface EnvRedactResult {
  env: Record<string, string>
  removed: string[]
}

export function redactEnv(env: NodeJS.ProcessEnv | Record<string, string>): EnvRedactResult {
  const out: Record<string, string> = {}
  const removed: string[] = []
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') continue
    if (ALWAYS_DENY.some(re => re.test(k))) {
      removed.push(k)
      continue
    }
    out[k] = v
  }
  return { env: out, removed }
}
