import type { Brain, BrainInferInput, BrainTurn } from './types'

/**
 * Echo brain for phase 1 — takes the event payload text and returns it
 * verbatim. Lets us wire and test the runtime loop before the real 0G
 * Compute integration lands in phase 3.
 */
export class StubBrain implements Brain {
  async infer(input: BrainInferInput): Promise<BrainTurn> {
    const text =
      typeof input.event.payload.data === 'string'
        ? input.event.payload.data
        : JSON.stringify(input.event.payload.data)
    return {
      content: `[stub-brain echo] ${text}`,
      toolCalls: [],
      finishReason: 'stop',
    }
  }
}
