import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface ActivityEntry {
  ts: number
  kind:
    | 'wake'
    | 'tool-call'
    | 'tool-result'
    | 'brain-response'
    | 'error'
    | 'context-compacted'
    | 'auto-topup'
  data: unknown
}

export class ActivityLog {
  private dirEnsured = false

  constructor(private readonly path: string) {}

  async append(entry: ActivityEntry): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(dirname(this.path), { recursive: true })
      this.dirEnsured = true
    }
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8')
  }
}
