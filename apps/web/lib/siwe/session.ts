// iron-session config for SIWE-authed operator sessions.

import 'server-only'
import { getIronSession } from 'iron-session'
import { cookies } from 'next/headers'
import type { Address } from 'viem'

export type SessionData = {
  address?: Address
  chainId?: number
  nonce?: string
  issuedAt?: string
}

export const SESSION_COOKIE = 'anima-console-session'

function getSecret(): string {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      'SESSION_SECRET env var missing or too short (need at least 32 chars). See apps/web/.env.local.example.',
    )
  }
  return secret
}

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), {
    password: getSecret(),
    cookieName: SESSION_COOKIE,
    cookieOptions: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      // Match max-age of cookie to a sane operator session lifespan.
      maxAge: 60 * 60 * 24 * 7,
    },
  })
}
