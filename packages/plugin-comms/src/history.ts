import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Address, Hex } from 'viem'

/**
 * Local sqlite-backed history. Each row is one inbound or outbound message
 * (text or file); the chain log is the canonical record, this table is the
 * brain-queryable cache + thread index. Keys: txHash + logIndex unique per
 * row (all messages share that pair).
 */
export interface HistoryRow {
  txHash: Hex
  logIndex: number
  blockNumber: number
  fromAddr: Address
  toAddr: Address
  /** Direction relative to the agent owning this DB. */
  direction: 'in' | 'out'
  type: 'msg' | 'file'
  content: string
  filename: string | null
  mime: string | null
  size: number | null
  inReplyTo: string | null
  ts: number
}

export class HistoryStore {
  private readonly db: Database

  constructor(agentDir: string) {
    const dbPath = join(agentDir, 'comms', 'history.db')
    if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        txHash      TEXT NOT NULL,
        logIndex    INTEGER NOT NULL,
        blockNumber INTEGER NOT NULL,
        fromAddr    TEXT NOT NULL,
        toAddr      TEXT NOT NULL,
        direction   TEXT NOT NULL CHECK (direction IN ('in','out')),
        type        TEXT NOT NULL CHECK (type IN ('msg','file')),
        content     TEXT NOT NULL,
        filename    TEXT,
        mime        TEXT,
        size        INTEGER,
        inReplyTo   TEXT,
        ts          INTEGER NOT NULL,
        PRIMARY KEY (txHash, logIndex)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_peer_ts
        ON messages(fromAddr, toAddr, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_thread
        ON messages(inReplyTo);
    `)
  }

  /**
   * Cheap existence check on the PRIMARY KEY `(txHash, logIndex)`. Used by
   * the listener to bail BEFORE the expensive ciphertext fetch + ECIES
   * decrypt steps when the safety-net periodic catch-up replays an event
   * the live subscribe already processed. Without this, every safety-net
   * tick (~60s) would re-fetch every spillover blob and re-decrypt every
   * inline message in the last `catchUpSafetyBlocks` window. PK lookup is
   * O(log n) on the sqlite btree.
   */
  has(txHash: Hex, logIndex: number): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM messages WHERE txHash = ? AND logIndex = ? LIMIT 1')
      .get(txHash, logIndex)
    return row !== null
  }

  /**
   * Insert a row. Returns `true` if a new row was inserted, `false` if the
   * row already existed (matched by PRIMARY KEY `(txHash, logIndex)`).
   *
   * The listener uses this return value to bail out of the brain-wake /
   * contact-gate steps when the same event is delivered twice — e.g. by both
   * the live `watchContractEvent` subscription AND the safety-net periodic
   * catch-up scan (v0.24.11). Without this signal, idempotent re-scans
   * would re-wake the brain for already-processed messages.
   */
  insert(row: HistoryRow): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
         (txHash, logIndex, blockNumber, fromAddr, toAddr, direction, type, content, filename, mime, size, inReplyTo, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.txHash,
        row.logIndex,
        row.blockNumber,
        row.fromAddr.toLowerCase(),
        row.toAddr.toLowerCase(),
        row.direction,
        row.type,
        row.content,
        row.filename,
        row.mime,
        row.size,
        row.inReplyTo,
        row.ts,
      )
    return result.changes > 0
  }

  /**
   * Search history. If `peer` is set, return messages where peer is either
   * the sender or recipient of an outbound. `limit` defaults to 50.
   */
  search(opts: { peer?: Address; limit?: number; afterTs?: number }): HistoryRow[] {
    const limit = Math.min(opts.limit ?? 50, 500)
    let sql = 'SELECT * FROM messages'
    const args: (string | number)[] = []
    const where: string[] = []
    if (opts.peer) {
      where.push('(fromAddr = ? OR toAddr = ?)')
      args.push(opts.peer.toLowerCase(), opts.peer.toLowerCase())
    }
    if (opts.afterTs) {
      where.push('ts > ?')
      args.push(opts.afterTs)
    }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`
    sql += ' ORDER BY ts DESC LIMIT ?'
    args.push(limit)
    return this.db.prepare(sql).all(...args) as HistoryRow[]
  }

  /**
   * Latest message txHash exchanged with `peer`, in either direction. Used
   * by `agent.message(...)` reply convenience to infer `inReplyTo`.
   */
  latestWith(peer: Address): HistoryRow | null {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE fromAddr = ? OR toAddr = ?
         ORDER BY ts DESC LIMIT 1`,
      )
      .get(peer.toLowerCase(), peer.toLowerCase()) as HistoryRow | null
  }

  threadOf(txHash: string): HistoryRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE inReplyTo = ? OR txHash = ? ORDER BY ts ASC')
      .all(txHash, txHash) as HistoryRow[]
  }

  close(): void {
    this.db.close()
  }
}
