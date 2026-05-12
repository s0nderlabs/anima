import { verifyAndParseSiwe } from '@/lib/siwe/messages'
import { getSession } from '@/lib/siwe/session'
import type { NextRequest } from 'next/server'
import type { Hex } from 'viem'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const session = await getSession()
  const expectedNonce = session.nonce
  if (!expectedNonce) {
    return Response.json({ ok: false, reason: 'no nonce issued' }, { status: 400 })
  }

  let body: { message?: string; signature?: Hex } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    return Response.json({ ok: false, reason: 'invalid json' }, { status: 400 })
  }
  if (!body.message || !body.signature) {
    return Response.json({ ok: false, reason: 'missing message or signature' }, { status: 400 })
  }

  const host = req.headers.get('host') || ''
  const expectedDomain = host.split(':')[0] === 'localhost' ? host : host.split(':')[0]
  // SIWE message domain often includes port for localhost (per EIP-4361 host
  // = "authority" minus userinfo). Accept either host (with port) or hostname
  // for localhost; for production we expect just the hostname.
  const candidates = new Set<string>()
  candidates.add(host)
  candidates.add(expectedDomain)

  const rawMessage = body.message
  let result: Awaited<ReturnType<typeof verifyAndParseSiwe>> | null = null
  for (const d of candidates) {
    result = await verifyAndParseSiwe(rawMessage, body.signature, expectedNonce, d)
    if (result.ok) break
  }
  if (!result || !result.ok) {
    return Response.json({ ok: false, reason: result?.reason ?? 'verify failed' }, { status: 401 })
  }

  session.address = result.data.address
  session.chainId = result.data.chainId
  // Rotate the nonce so the same SIWE message cannot be replayed.
  session.nonce = undefined
  await session.save()
  return Response.json({ ok: true, address: result.data.address })
}
