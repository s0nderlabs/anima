import { mkdir } from 'node:fs/promises'
import type { Brain } from '../brain/types'
import type { AnimaConfig } from '../config'
import { EventQueue, listeners, newEventId, routeLoop } from '../events'
import type { AnimaEvent } from '../events/types'
import type { IdentityProvider } from '../identity/types'
import { addEntryLine, readIndexFile, writeIndexFile } from '../memory/index-file'
import { agentPaths } from '../paths'
import type { Storage } from '../storage/types'
import { ToolRegistry } from '../tools/registry'
import { type ActivityEntry, ActivityLog } from './activity'

export interface RuntimeDeps {
  config: AnimaConfig
  identity: IdentityProvider
  brain: Brain
  storage: Storage
}

export class Runtime {
  readonly queue: EventQueue
  readonly tools: ToolRegistry
  private activity?: ActivityLog
  private running = false
  private routeTask?: Promise<void>

  constructor(private readonly deps: RuntimeDeps) {
    this.queue = new EventQueue()
    this.tools = new ToolRegistry(deps.config.tools)
  }

  /** Ensure per-agent filesystem exists and boot the event loop. */
  async start(): Promise<void> {
    if (this.running) return
    const id = (await this.deps.identity.current()).agentId
    const paths = agentPaths.agent(id)

    await mkdir(paths.memoryDir, { recursive: true })
    await mkdir(paths.agentMemoryDir, { recursive: true })
    await mkdir(paths.userMemoryDir, { recursive: true })
    await mkdir(paths.publicDir, { recursive: true })
    await mkdir(paths.cache, { recursive: true })

    this.activity = new ActivityLog(paths.activityLog)

    // Initialize MEMORY.md if missing.
    let index = await readIndexFile(paths.memoryIndex)
    if (index.lines.length === 0) {
      index = {
        lines: [
          `# ${id} — Memory Index`,
          '',
          'Self-contained memory for this agent. Topic files live under `agent/` (transfers with iNFT) and `user/` (purges on transfer).',
          '',
          '## Memories',
          '',
        ],
        entries: new Map(),
      }
      index = addEntryLine(index, {
        file: 'agent/identity.md',
        title: 'Agent identity',
        hook: 'Seed record of this agent — tokenId, creation block, operator history.',
      })
      await writeIndexFile(paths.memoryIndex, index)
    }

    this.routeTask = routeLoop(this.queue, {
      brain: this.deps.brain,
      tools: this.tools,
      onTurn: async (ev, turn) => {
        await this.activity?.append({
          ts: Date.now(),
          kind: 'brain-response',
          data: {
            event: { id: ev.id, source: ev.source },
            content: turn.content,
            toolCalls: turn.toolCalls,
            finishReason: turn.finishReason,
            usage: turn.usage,
          },
        })
      },
    })
    this.running = true

    await listeners.startAll(this.queue)
  }

  /** Push an event onto the queue from outside the listener system. */
  async fire(event: Omit<AnimaEvent, 'id' | 'ts'>): Promise<string> {
    const ev: AnimaEvent = { ...event, id: newEventId(), ts: Date.now() }
    await this.activity?.append({
      ts: ev.ts,
      kind: 'wake',
      data: { id: ev.id, source: ev.source, label: ev.payload.label },
    })
    this.queue.enqueue(ev)
    return ev.id
  }

  async logActivity(entry: ActivityEntry): Promise<void> {
    await this.activity?.append(entry)
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.queue.close()
    await listeners.stopAll()
    await this.routeTask
  }
}
