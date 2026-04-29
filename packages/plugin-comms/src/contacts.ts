import { join } from 'node:path'
import type { Address } from 'viem'
import { loadJson, saveJson } from './state-files'

/**
 * Approved sender record. The brain only sees inbound messages from
 * approved contacts (or in-pending if the operator approves explicitly).
 */
export interface Contact {
  addr: Address
  /** Optional friendly name (e.g. an `.anima.0g` resolved earlier). */
  name?: string
  addedAt: number
}

export interface PendingRequest {
  addr: Address
  firstSeenAt: number
  /** Last-seen ts, used to throttle re-prompts. */
  lastSeenAt: number
  /** How many messages we've buffered since first contact. */
  count: number
}

interface ContactsFile {
  v: 1
  contacts: Record<string, Contact>
  pending: Record<string, PendingRequest>
  blocked: Record<string, { addr: Address; blockedAt: number }>
}

const DEFAULT: ContactsFile = { v: 1, contacts: {}, pending: {}, blocked: {} }

export class ContactStore {
  private readonly path: string
  private state: ContactsFile

  constructor(agentDir: string) {
    this.path = join(agentDir, 'comms', 'contacts.json')
    this.state = loadJson(this.path, DEFAULT)
  }

  find(addr: Address): Contact | null {
    return this.state.contacts[addr.toLowerCase()] ?? null
  }

  has(addr: Address): boolean {
    return this.find(addr) !== null
  }

  isPending(addr: Address): boolean {
    return Boolean(this.state.pending[addr.toLowerCase()])
  }

  isBlocked(addr: Address): boolean {
    return Boolean(this.state.blocked[addr.toLowerCase()])
  }

  add(addr: Address, name?: string): void {
    const k = addr.toLowerCase()
    this.state.contacts[k] = { addr, name, addedAt: Date.now() }
    delete this.state.pending[k]
    delete this.state.blocked[k]
    saveJson(this.path, this.state)
  }

  remove(addr: Address): boolean {
    const k = addr.toLowerCase()
    const had = Boolean(this.state.contacts[k])
    delete this.state.contacts[k]
    if (had) saveJson(this.path, this.state)
    return had
  }

  block(addr: Address): void {
    const k = addr.toLowerCase()
    this.state.blocked[k] = { addr, blockedAt: Date.now() }
    delete this.state.contacts[k]
    delete this.state.pending[k]
    saveJson(this.path, this.state)
  }

  unblock(addr: Address): boolean {
    const k = addr.toLowerCase()
    const had = Boolean(this.state.blocked[k])
    delete this.state.blocked[k]
    if (had) saveJson(this.path, this.state)
    return had
  }

  /**
   * Note an inbound from an unknown sender. Returns true on first contact
   * (caller should surface a "X wants to chat" notification), false on
   * repeat (caller should silently drop or buffer).
   */
  recordPending(addr: Address): boolean {
    const k = addr.toLowerCase()
    const existing = this.state.pending[k]
    if (existing) {
      existing.lastSeenAt = Date.now()
      existing.count++
      saveJson(this.path, this.state)
      return false
    }
    this.state.pending[k] = {
      addr,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      count: 1,
    }
    saveJson(this.path, this.state)
    return true
  }

  list(): Contact[] {
    return Object.values(this.state.contacts).sort((a, b) => a.addedAt - b.addedAt)
  }

  /**
   * Find a contact by friendly name (case-insensitive). The brain naturally
   * uses labels (`specter`) when sending, but the resolver only knows .0g
   * names + 0x addresses; this hook lets `resolveAddrOrName` fall back to
   * the local label table.
   */
  findByLabel(label: string): Contact | null {
    const needle = label.toLowerCase()
    for (const c of Object.values(this.state.contacts)) {
      if (c.name && c.name.toLowerCase() === needle) return c
    }
    return null
  }

  listPending(): PendingRequest[] {
    return Object.values(this.state.pending).sort((a, b) => a.firstSeenAt - b.firstSeenAt)
  }

  listBlocked(): Address[] {
    return Object.values(this.state.blocked).map(b => b.addr)
  }
}
