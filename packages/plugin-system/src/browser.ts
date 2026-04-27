import { spawn } from 'node:child_process'
import { type ToolDef, coerceBool, redactEnv } from '@s0nderlabs/anima-core'
import { z } from 'zod'

/**
 * Phase 9.4 browser tools. Thin wrappers around the `agent-browser` CLI
 * (https://github.com/agent-browser, locally installed via Homebrew). Each
 * tool runs `agent-browser <subcommand> ...` and returns stdout.
 *
 * All browser tools are `shouldDefer: true` so the brain's prompt stays small
 * unless the user invokes `tool.search` with a browser-related keyword. The
 * agent-browser binary check happens lazily; first invocation surfaces a
 * clean install message if the CLI is missing.
 */

interface BrowserDeps {
  /** Override the agent-browser binary path. Default 'agent-browser' (PATH lookup). */
  binPath?: string
  /** Working directory for the spawned process. Default cwd. */
  cwd?: string
}

interface RunResult {
  ok: boolean
  data?: { stdout: string; stderr?: string; exit_code: number | null }
  error?: string
}

async function runAgentBrowser(args: string[], deps: BrowserDeps): Promise<RunResult> {
  const bin = deps.binPath ?? 'agent-browser'
  const { env } = redactEnv(process.env as Record<string, string>)
  return await new Promise<RunResult>(resolve => {
    let stdout = ''
    let stderr = ''
    const proc = spawn(bin, args, { cwd: deps.cwd ?? process.cwd(), env })
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', chunk => {
      stdout += chunk as string
      if (stdout.length > 100_000) stdout = stdout.slice(-100_000)
    })
    proc.stderr?.on('data', chunk => {
      stderr += chunk as string
      if (stderr.length > 50_000) stderr = stderr.slice(-50_000)
    })
    proc.on('error', err => {
      const msg = err.message
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({
          ok: false,
          error:
            'agent-browser CLI not found. Install with `brew install agent-browser` (or set ANIMA_AGENT_BROWSER_BIN). Browser tools require it.',
        })
        return
      }
      resolve({ ok: false, error: msg })
    })
    proc.on('close', code => {
      resolve({
        ok: (code ?? 1) === 0,
        data: { stdout, stderr, exit_code: code },
      })
    })
  })
}

const NavigateSchema = z.object({
  url: z.string().min(1).describe('Absolute URL to navigate to (e.g. https://...).'),
})

export function makeBrowserNavigate(deps: BrowserDeps): ToolDef<z.infer<typeof NavigateSchema>> {
  return {
    name: 'browser.navigate',
    description: 'Open a URL in the agent-browser tab. Returns the new page metadata.',
    shouldDefer: true,
    searchHint: 'browser navigate open url page',
    schema: NavigateSchema,
    handler: async args => runAgentBrowser(['open', args.url], deps),
  }
}

const SnapshotSchema = z.object({
  with_image: coerceBool
    .optional()
    .describe('When true, also captures a screenshot saved alongside the accessibility tree.'),
  cap: coerceBool
    .optional()
    .describe('Cap the snapshot output for compactness. Defaults to true (-c flag).'),
})

export function makeBrowserSnapshot(deps: BrowserDeps): ToolDef<z.infer<typeof SnapshotSchema>> {
  return {
    name: 'browser.snapshot',
    description:
      'Capture the page accessibility tree with element refs (@e1, @e2, ...). Use refs returned here for click/type/scroll actions. Set with_image=true to also write a screenshot.',
    shouldDefer: true,
    searchHint: 'browser snapshot accessibility tree refs page state',
    schema: SnapshotSchema,
    handler: async args => {
      const flags = ['snapshot']
      if (args.with_image !== false) flags.push('-i')
      if (args.cap !== false) flags.push('-c')
      return runAgentBrowser(flags, deps)
    },
  }
}

const ClickSchema = z.object({
  selector: z
    .string()
    .min(1)
    .describe("CSS selector OR snapshot ref (e.g. '@e5', 'button.primary')."),
})

export function makeBrowserClick(deps: BrowserDeps): ToolDef<z.infer<typeof ClickSchema>> {
  return {
    name: 'browser.click',
    description: 'Click an element by selector or snapshot ref.',
    shouldDefer: true,
    searchHint: 'browser click element selector ref',
    schema: ClickSchema,
    handler: async args => runAgentBrowser(['click', args.selector], deps),
  }
}

const TypeSchema = z.object({
  selector: z.string().min(1),
  text: z.string().describe('Text to type into the element.'),
})

export function makeBrowserType(deps: BrowserDeps): ToolDef<z.infer<typeof TypeSchema>> {
  return {
    name: 'browser.type',
    description: 'Type text into an element by selector or snapshot ref.',
    shouldDefer: true,
    searchHint: 'browser type input text fill',
    schema: TypeSchema,
    handler: async args => runAgentBrowser(['type', args.selector, args.text], deps),
  }
}

const ScrollSchema = z.object({
  direction: z.enum(['up', 'down', 'left', 'right']),
  pixels: z.number().int().positive().optional().describe('Default 800.'),
})

export function makeBrowserScroll(deps: BrowserDeps): ToolDef<z.infer<typeof ScrollSchema>> {
  return {
    name: 'browser.scroll',
    description: 'Scroll the page in a direction by N pixels.',
    shouldDefer: true,
    searchHint: 'browser scroll page up down',
    schema: ScrollSchema,
    handler: async args => {
      const args2 = ['scroll', args.direction]
      if (args.pixels) args2.push(String(args.pixels))
      return runAgentBrowser(args2, deps)
    },
  }
}

const BackSchema = z.object({})

export function makeBrowserBack(deps: BrowserDeps): ToolDef<z.infer<typeof BackSchema>> {
  return {
    name: 'browser.back',
    description: 'Navigate the browser history back one step.',
    shouldDefer: true,
    searchHint: 'browser back history previous page',
    schema: BackSchema,
    handler: async () => runAgentBrowser(['back'], deps),
  }
}

const PressSchema = z.object({
  key: z.string().min(1).describe("Key to press, e.g. 'Enter', 'Tab', 'Escape', 'Control+a'."),
})

export function makeBrowserPress(deps: BrowserDeps): ToolDef<z.infer<typeof PressSchema>> {
  return {
    name: 'browser.press',
    description: 'Send a single key press (Enter, Tab, Escape, Ctrl+A, etc.).',
    shouldDefer: true,
    searchHint: 'browser press key keyboard',
    schema: PressSchema,
    handler: async args => runAgentBrowser(['press', args.key], deps),
  }
}

const GetImagesSchema = z.object({
  selector: z.string().optional().describe('Optional CSS selector to scope image extraction.'),
})

export function makeBrowserGetImages(deps: BrowserDeps): ToolDef<z.infer<typeof GetImagesSchema>> {
  return {
    name: 'browser.get_images',
    description:
      'Extract image URLs from the current page. Optionally scoped to a selector. Returns array of src URLs.',
    shouldDefer: true,
    searchHint: 'browser images src extract list',
    schema: GetImagesSchema,
    handler: async args => {
      const sel = args.selector ?? 'img'
      return runAgentBrowser(['get', 'attr', 'src', sel], deps)
    },
  }
}

const VisionSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe('What you want the vision model to answer/describe about the screenshot.'),
})

export function makeBrowserVision(
  deps: BrowserDeps & { supportsVision: boolean; modelLabel?: string },
): ToolDef<z.infer<typeof VisionSchema>> {
  return {
    name: 'browser.vision',
    description:
      "Capture the current page as a screenshot and send it to the configured vision model with a prompt. Returns the model's reply. Currently inactive: 0G Compute is text-only as of Apr 2026.",
    shouldDefer: true,
    searchHint: 'browser vision screenshot describe ocr image',
    schema: VisionSchema,
    handler: async () => {
      if (!deps.supportsVision) {
        return {
          ok: false,
          error: `vision-capable brain provider required (current: ${deps.modelLabel ?? 'unknown'}).`,
        }
      }
      // When 0G ships a vision provider, capture screenshot and route to brain.
      return { ok: false, error: 'vision provider configured but no impl yet (Phase 9.4 stub)' }
    },
  }
}

const ConsoleSchema = z.object({
  clear: coerceBool.optional().describe('When true, clears console after reading.'),
})

export function makeBrowserConsole(deps: BrowserDeps): ToolDef<z.infer<typeof ConsoleSchema>> {
  return {
    name: 'browser.console',
    description: 'Read accumulated console output (logs, warnings, errors) from the page.',
    shouldDefer: true,
    searchHint: 'browser console logs warnings errors',
    schema: ConsoleSchema,
    handler: async args => {
      const flags = ['console']
      if (args.clear) flags.push('--clear')
      return runAgentBrowser(flags, deps)
    },
  }
}

export const ALL_BROWSER_TOOL_FACTORIES = [
  makeBrowserNavigate,
  makeBrowserSnapshot,
  makeBrowserClick,
  makeBrowserType,
  makeBrowserScroll,
  makeBrowserBack,
  makeBrowserPress,
  makeBrowserGetImages,
  makeBrowserConsole,
]
