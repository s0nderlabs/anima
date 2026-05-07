// `anima admin <sub>` — operator-only ops dispatch. Mirrors `pairing.ts` shape.

export interface AdminArgs {
  sub: 'autotopup-tick'
}

const VALID_SUBS = ['autotopup-tick'] as const

export type AdminParseResult = AdminArgs | { error: string }

export function parseAdminArgs(argv: string[]): AdminParseResult {
  const sub = argv[0]
  if (!sub) {
    return {
      error: `usage: anima admin <${VALID_SUBS.join(' | ')}>`,
    }
  }
  if (!(VALID_SUBS as readonly string[]).includes(sub)) {
    return { error: `unknown subcommand '${sub}' (expected: ${VALID_SUBS.join(' | ')})` }
  }
  return { sub: sub as AdminArgs['sub'] }
}

export async function runAdmin(args: AdminArgs): Promise<void> {
  switch (args.sub) {
    case 'autotopup-tick': {
      const { runAdminAutotopupTick } = await import('./admin-autotopup-tick')
      await runAdminAutotopupTick()
      return
    }
  }
}
