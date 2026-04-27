import type { ClaudeAgent, DelegateBrainFactory, ToolDef } from '@s0nderlabs/anima-core'
import { z } from 'zod'

/**
 * `delegate.task` spawns an isolated sub-brain with a constrained system
 * prompt + tool subset. Used by the parent brain to off-load focused work
 * (extraction, drafting, classification) without polluting its own context.
 * Claude Code agents (~/.claude/plugins/cache/<m>/<p>/<v>/agents/<name>.md)
 * are addressable via the `agent:` arg.
 */

interface DelegateDeps {
  /** Builds a fresh brain instance. Chat.tsx supplies this with broker creds. */
  makeBrain: DelegateBrainFactory
  /** Claude Code agents available by short name. */
  agents: ClaudeAgent[]
}

const DelegateSchema = z.object({
  agent: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Name of a Claude Code agent (e.g. 'thymos', 'contract-explainer') OR omit and provide system_prompt directly.",
    ),
  system_prompt: z
    .string()
    .min(1)
    .optional()
    .describe('Custom system prompt for the sub-brain. Used when no agent is specified.'),
  task: z.string().min(1).describe('The task description / user-message the sub-brain receives.'),
  max_output_tokens: z.number().int().positive().max(8_000).optional(),
})

export function makeDelegateTask(deps: DelegateDeps): ToolDef<z.infer<typeof DelegateSchema>> {
  return {
    name: 'delegate.task',
    description:
      'Run a task on a sub-brain (same provider, isolated context). Useful for extraction, summarisation, classification. Pass `agent: <name>` for a Claude Code agent OR `system_prompt` for ad-hoc instructions. Returns content + token usage.',
    searchHint: 'delegate task subagent isolated sub brain',
    schema: DelegateSchema,
    handler: async args => {
      let systemPrompt: string
      if (args.agent) {
        const agent = deps.agents.find(a => a.name === args.agent || a.id === args.agent)
        if (!agent) {
          return { ok: false, error: `unknown agent: ${args.agent}` }
        }
        systemPrompt =
          agent.body.trim().length > 0 ? agent.body : `You are ${agent.name}. ${agent.description}`
      } else if (args.system_prompt) {
        systemPrompt = args.system_prompt
      } else {
        return { ok: false, error: 'either agent or system_prompt is required' }
      }
      try {
        const subBrain = await deps.makeBrain({ systemPrompt, tools: [] })
        const turn = await subBrain.infer({
          event: {
            id: `delegate-${Date.now()}`,
            source: 'stdin',
            payload: { label: 'delegate', data: args.task },
            ts: Date.now(),
          },
        })
        return {
          ok: true,
          data: {
            content: turn.content,
            finishReason: turn.finishReason,
            usage: turn.usage,
            agent: args.agent ?? null,
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
  }
}

const VisionSchema = z.object({
  image_path: z.string().min(1).describe('Absolute path to the image to analyze.'),
  prompt: z.string().min(1).describe('Question or instruction for the vision model.'),
})

export interface VisionDeps {
  /**
   * When true, the brain provider supports image inputs. anima sets this from
   * config.brain. With current 0G Compute models (text-only as of Apr 2026),
   * this is always false; the tool returns a clear "not available" result.
   */
  supportsVision: boolean
  /** Provider model id for messaging the user clearly. */
  modelLabel?: string
}

export function makeVisionAnalyze(deps: VisionDeps): ToolDef<z.infer<typeof VisionSchema>> {
  return {
    name: 'vision.analyze',
    description:
      "Describe / answer questions about an image. Currently inactive: 0G Compute's flagship models are text-only as of Apr 2026; this tool returns 'not available' until a vision-capable provider is configured.",
    searchHint: 'vision image analyze describe ocr photo',
    schema: VisionSchema,
    handler: async () => {
      if (!deps.supportsVision) {
        return {
          ok: false,
          error: `vision-capable brain provider required (current: ${
            deps.modelLabel ?? 'unknown'
          }). Switch via 'anima model' to a multimodal provider when 0G adds one.`,
        }
      }
      // When 0G ships a vision provider, swap this for the real broker call.
      return { ok: false, error: 'vision provider configured but no impl yet' }
    },
  }
}
