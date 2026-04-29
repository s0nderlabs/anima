/**
 * Anima A2A message envelope. Plaintext schema that wraps the actual content
 * before ECIES encryption. Lets one envelope codec serve text + file + future
 * types without a contract change.
 *
 * The envelope is JSON-encoded then ECIES-encrypted. Receiver decrypts, parses
 * JSON, dispatches on `type`. `from` from the chain event is canonical for
 * sender identity; `inReplyTo` is just a soft hint for threading (a tx hash
 * the brain may use to link to a prior message).
 */

export type EnvelopeType = 'msg' | 'file'

export interface MessageEnvelope {
  v: 1
  type: 'msg'
  /** UTF-8 text body. */
  content: string
  /** Optional inReplyTo tx hash (soft thread anchor). */
  inReplyTo?: string
}

export interface FileEnvelope {
  v: 1
  type: 'file'
  /** Original filename for display. Sanitize when saving to disk. */
  filename: string
  /** MIME type sniffed at send time. */
  mime: string
  /** Decrypted blob byte size, for receiver budget decisions. */
  size: number
  /** Optional human caption shown alongside the attachment. */
  caption?: string
  /** Optional inReplyTo. */
  inReplyTo?: string
}

export type Envelope = MessageEnvelope | FileEnvelope

/**
 * Encode an envelope to bytes for ECIES encryption.
 */
export function encodeEnvelope(e: Envelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(e))
}

/**
 * Decode bytes back into an envelope. Throws on schema mismatch.
 */
export function decodeEnvelope(bytes: Uint8Array): Envelope {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`envelope JSON parse failed: ${(e as Error).message.slice(0, 120)}`)
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('envelope is not an object')
  const obj = raw as Record<string, unknown>
  if (obj.v !== 1) throw new Error(`unsupported envelope version: ${obj.v}`)
  if (obj.type === 'msg') {
    if (typeof obj.content !== 'string') throw new Error('msg envelope missing string content')
    return {
      v: 1,
      type: 'msg',
      content: obj.content,
      ...(typeof obj.inReplyTo === 'string' ? { inReplyTo: obj.inReplyTo } : {}),
    }
  }
  if (obj.type === 'file') {
    if (
      typeof obj.filename !== 'string' ||
      typeof obj.mime !== 'string' ||
      typeof obj.size !== 'number'
    ) {
      throw new Error('file envelope missing required fields')
    }
    return {
      v: 1,
      type: 'file',
      filename: obj.filename,
      mime: obj.mime,
      size: obj.size,
      ...(typeof obj.caption === 'string' ? { caption: obj.caption } : {}),
      ...(typeof obj.inReplyTo === 'string' ? { inReplyTo: obj.inReplyTo } : {}),
    }
  }
  throw new Error(`unknown envelope type: ${String(obj.type)}`)
}
