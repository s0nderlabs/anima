import { detectDangerousCommand } from './dangerous'

/**
 * Permission system core. Three resolution modes:
 *   - 'strict': dangerous patterns always denied, no prompt
 *   - 'prompt': dangerous patterns prompt the user once / for the session / deny
 *   - 'off' (YOLO): dangerous patterns allowed silently
 *
 * Approvals are scoped per-session via a Set of allowed pattern keys. The
 * service is UI-agnostic; chat.tsx wires `setPrompter()` to its own modal.
 * In headless contexts (tests, scripted CLI) the default prompter denies.
 */
export type PermissionMode = 'strict' | 'prompt' | 'off'
export type PermissionDecision = 'allow-once' | 'allow-session' | 'deny'

export interface PermissionRequest {
  kind: 'shell.run' | 'shell.process' | 'code.execute' | 'fs.write' | 'fs.patch'
  command?: string
  path?: string
  /** Description of why approval is needed (e.g. "delete in root path"). */
  reason: string
}

export type PermissionPrompter = (req: PermissionRequest) => Promise<PermissionDecision>

export interface PermissionServiceOpts {
  mode: PermissionMode
  prompter?: PermissionPrompter
}

const DEFAULT_DENY_PROMPTER: PermissionPrompter = async () => 'deny'

export class PermissionService {
  private mode: PermissionMode
  private prompter: PermissionPrompter
  private readonly sessionAllowed = new Set<string>()

  constructor(opts: PermissionServiceOpts) {
    this.mode = opts.mode
    this.prompter = opts.prompter ?? DEFAULT_DENY_PROMPTER
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode
  }

  setPrompter(p: PermissionPrompter): void {
    this.prompter = p
  }

  isYolo(): boolean {
    return this.mode === 'off'
  }

  getMode(): PermissionMode {
    return this.mode
  }

  /**
   * Resolve a permission for a tool call.
   *   - YOLO ('off'): always allow.
   *   - Strict: dangerous pattern => deny, otherwise allow.
   *   - Prompt: dangerous pattern OR shell.run => consult `prompter`,
   *     honour session-allow on subsequent identical signatures.
   */
  async resolve(req: PermissionRequest): Promise<{
    allowed: boolean
    reason?: string
    via: 'yolo' | 'allow' | 'session-allow' | 'once' | 'deny' | 'strict-deny'
  }> {
    if (this.mode === 'off') return { allowed: true, via: 'yolo' }

    const sigKey = this.signature(req)
    if (this.sessionAllowed.has(sigKey)) {
      return { allowed: true, via: 'session-allow' }
    }

    const dangerous = req.command ? detectDangerousCommand(req.command) : { match: false as const }

    if (this.mode === 'strict') {
      if (dangerous.match) {
        return { allowed: false, reason: dangerous.description, via: 'strict-deny' }
      }
      return { allowed: true, via: 'allow' }
    }

    // mode === 'prompt': dangerous patterns + every shell-class invocation consult the prompter.
    if (dangerous.match) {
      const decision = await this.prompter({ ...req, reason: dangerous.description })
      return this.applyDecision(decision, sigKey)
    }
    if (req.kind === 'shell.run' || req.kind === 'shell.process' || req.kind === 'code.execute') {
      const decision = await this.prompter(req)
      return this.applyDecision(decision, sigKey)
    }
    return { allowed: true, via: 'allow' }
  }

  /**
   * Approve a fs.write/fs.patch path explicitly (skip prompter). Tests use
   * this; chat.tsx wires it through the approval modal.
   */
  approveSession(req: PermissionRequest): void {
    this.sessionAllowed.add(this.signature(req))
  }

  private applyDecision(
    decision: PermissionDecision,
    sigKey: string,
  ): { allowed: boolean; via: 'session-allow' | 'once' | 'deny' } {
    if (decision === 'allow-session') {
      this.sessionAllowed.add(sigKey)
      return { allowed: true, via: 'session-allow' }
    }
    if (decision === 'allow-once') return { allowed: true, via: 'once' }
    return { allowed: false, via: 'deny' }
  }

  private signature(req: PermissionRequest): string {
    return [req.kind, req.command ?? '', req.path ?? ''].join('|')
  }
}
