import { type ChildProcess, spawn } from 'node:child_process'
import type { McpServerStdio } from './types'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification

const PROTOCOL_VERSION = '2024-11-05'
const CLIENT_INFO = { name: 'anima', version: '0.8.1' }

export class McpStdioClient {
  private proc: ChildProcess | null = null
  private nextId = 1
  private buffer = ''
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private starting: Promise<void> | null = null

  constructor(public readonly server: McpServerStdio) {}

  async ensureStarted(timeoutMs = 10_000): Promise<void> {
    if (this.proc) return
    if (this.starting) return this.starting
    this.starting = this.spawnAndInitialize(timeoutMs)
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private async spawnAndInitialize(timeoutMs: number): Promise<void> {
    const proc = spawn(this.server.command, this.server.args ?? [], {
      env: { ...process.env, ...(this.server.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc = proc
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', chunk => this.onStdout(chunk as string))
    proc.on('error', err => this.failAll(err))
    proc.on('exit', () => this.failAll(new Error(`mcp server '${this.server.name}' exited`)))
    // Initialize handshake
    const initPromise = this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`mcp init timeout (${timeoutMs}ms)`)), timeoutMs),
    )
    await Promise.race([initPromise, timeout])
    this.notify('notifications/initialized', {})
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema?: unknown }[]> {
    await this.ensureStarted()
    const result = (await this.request('tools/list', {})) as {
      tools?: { name: string; description?: string; inputSchema?: unknown }[]
    }
    return result.tools ?? []
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    await this.ensureStarted()
    return await this.request('tools/call', { name, arguments: args })
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (!this.proc?.stdin) throw new Error('mcp server not started')
    const id = this.nextId++
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.proc!.stdin!.write(`${JSON.stringify(req)}\n`, err => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  notify(method: string, params: unknown): void {
    if (!this.proc?.stdin) return
    const note: JsonRpcNotification = { jsonrpc: '2.0', method, params }
    this.proc.stdin.write(`${JSON.stringify(note)}\n`)
  }

  close(): void {
    if (!this.proc) return
    try {
      this.proc.stdin?.end()
    } catch {}
    try {
      this.proc.kill('SIGTERM')
    } catch {}
    this.proc = null
    this.failAll(new Error('mcp client closed'))
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    let nl = this.buffer.indexOf('\n')
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      nl = this.buffer.indexOf('\n')
      if (!line) continue
      let parsed: JsonRpcMessage
      try {
        parsed = JSON.parse(line) as JsonRpcMessage
      } catch {
        continue
      }
      this.dispatch(parsed)
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if ('id' in msg) {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
      else pending.resolve(msg.result ?? null)
    }
    // Notifications from the server are ignored for now.
  }

  private failAll(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err)
    this.pending.clear()
  }
}
