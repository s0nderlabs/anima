import type { Brain, BrainTurn } from '../brain/types'
import type { ToolRegistry } from '../tools/registry'
import type { EventQueue } from './queue'
import type { AnimaEvent } from './types'

export interface RouterDeps {
  brain: Brain
  tools: ToolRegistry
  onTurn?: (ev: AnimaEvent, turn: BrainTurn) => void | Promise<void>
}

/**
 * Pulls events from the queue, assembles a prompt via the brain, executes any
 * returned tool_calls until the brain produces a final message, and yields
 * the turn back via `onTurn`.
 */
export async function routeLoop(queue: EventQueue, deps: RouterDeps): Promise<void> {
  for await (const ev of queue) {
    if (!ev.source) continue // closed sentinel
    await handleOne(ev, deps)
  }
}

async function handleOne(ev: AnimaEvent, deps: RouterDeps): Promise<void> {
  // Seed conversation with the triggering event (stub does echo; real brain
  // in phase 3 will load memory, assemble frozen prefix, etc.)
  const turn = await deps.brain.infer({ event: ev })

  // Resolve any tool calls in a single iteration for MVP — phase 3 extends
  // this to a proper multi-turn loop.
  for (const call of turn.toolCalls ?? []) {
    const tool = deps.tools.find(call.name)
    if (!tool) continue
    try {
      await tool.handler(call.args)
    } catch {
      // Tool errors are surfaced in activity log by the runtime, not here.
    }
  }

  await deps.onTurn?.(ev, turn)
}
