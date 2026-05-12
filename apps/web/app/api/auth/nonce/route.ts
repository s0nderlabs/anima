import { randomNonce } from '@/lib/siwe/messages'
import { getSession } from '@/lib/siwe/session'

export const runtime = 'nodejs'

export async function GET() {
  const session = await getSession()
  const nonce = randomNonce()
  session.nonce = nonce
  session.issuedAt = new Date().toISOString()
  await session.save()
  return Response.json({ nonce })
}
