/**
 * CLI argv dispatch. Keeps phase 2 minimal: no subcommand → chat REPL,
 * otherwise route to commands/<name>.
 */

const argv = process.argv.slice(2)
// First arg starting with `--` means the user invoked the default subcommand
// (chat) with flags, e.g. `anima --yolo`. Treat it as if `chat` were implicit.
// Exception: `--help` and `--version` are top-level commands, not chat flags.
const first = argv[0]
const isTopLevelFlag = first === '--help' || first === '--version'
const sub = first?.startsWith('--') && !isTopLevelFlag ? 'chat' : first

async function main(): Promise<void> {
  switch (sub) {
    case undefined:
    case 'chat': {
      const { runChat } = await import('./commands/chat')
      await runChat({ yolo: argv.includes('--yolo') })
      return
    }
    case 'init': {
      if (argv.includes('--resume')) {
        const { findAndLoadConfig } = await import('./config/load')
        const loaded = await findAndLoadConfig()
        if (!loaded) {
          console.error('anima init --resume: no anima.config.ts found in cwd or parents.')
          process.exit(1)
        }
        const { runResumeInit } = await import('./commands/init/resume')
        await runResumeInit({ config: loaded.config, configPath: loaded.path })
        return
      }
      const { runInit } = await import('./commands/init')
      await runInit()
      return
    }
    case 'status': {
      const { runStatus } = await import('./commands/status')
      await runStatus()
      return
    }
    case 'logs': {
      const { runLogs } = await import('./commands/logs')
      const tailIdx = argv.indexOf('--tail')
      const tail = tailIdx >= 0 ? Number(argv[tailIdx + 1]) : undefined
      const agentIdx = argv.indexOf('--agent')
      const agent = agentIdx >= 0 ? argv[agentIdx + 1] : undefined
      await runLogs({ agent, tail })
      return
    }
    case 'restore': {
      const ref = argv[1]
      if (!ref) {
        console.error(
          'usage: anima restore <iNFT-ref>\n  ref formats:\n    eip155:16661:0x<contract>:<tokenId>\n    0g-mainnet:0x<contract>:<tokenId>\n    0g-testnet:0x<contract>:<tokenId>',
        )
        process.exit(1)
      }
      const { runRestore } = await import('./commands/restore')
      await runRestore({ ref })
      return
    }
    case 'transfer': {
      const { parseTransferArgs, runTransfer } = await import('./commands/transfer')
      const parsed = parseTransferArgs(argv.slice(1))
      if ('error' in parsed) {
        console.error(
          `anima transfer: ${parsed.error}\n  usage: anima transfer <iNFT-ref> --to <addr> [--recipient-key 0x...] [--dry-run] [--yes] [--no-purge]`,
        )
        process.exit(1)
      }
      await runTransfer(parsed)
      return
    }
    case 'topup': {
      const agentIdx = argv.indexOf('--agent')
      const computeIdx = argv.indexOf('--compute')
      // v0.21.5: --sandbox is the canonical flag for SandboxBilling (Galileo
      // testnet runtime fees). --provider stays as a deprecated alias for
      // backwards compat with v0.17.1+ runbooks.
      const sandboxIdx = argv.indexOf('--sandbox')
      const providerIdx = argv.indexOf('--provider')
      const visionIdx = argv.indexOf('--vision')
      const parseAmount = (flag: string, raw: string | undefined): number | undefined => {
        if (raw === undefined) return undefined
        const n = Number(raw)
        if (!Number.isFinite(n) || n <= 0 || n > 1e6) {
          console.error(
            `Bad amount for ${flag}: ${raw}\n  Each topup flag takes an amount in 0G, not an address: ${flag} <amount>\n  Examples: anima topup --compute 2     anima topup --sandbox 5     anima topup --agent 1     anima topup --vision 1`,
          )
          process.exit(2)
        }
        return n
      }
      const agent = parseAmount('--agent', agentIdx >= 0 ? argv[agentIdx + 1] : undefined)
      const compute = parseAmount('--compute', computeIdx >= 0 ? argv[computeIdx + 1] : undefined)
      const sandboxArg = parseAmount(
        '--sandbox',
        sandboxIdx >= 0 ? argv[sandboxIdx + 1] : undefined,
      )
      const providerLegacyArg = parseAmount(
        '--provider',
        providerIdx >= 0 ? argv[providerIdx + 1] : undefined,
      )
      const vision = parseAmount('--vision', visionIdx >= 0 ? argv[visionIdx + 1] : undefined)
      if (providerLegacyArg !== undefined && sandboxArg === undefined) {
        console.warn(
          '[deprecated] `anima topup --provider` is renamed to `--sandbox` (Galileo testnet billing); both flags work for now but `--provider` will be removed in a future release.',
        )
      } else if (providerLegacyArg !== undefined && sandboxArg !== undefined) {
        console.error(
          'anima topup: cannot pass both --sandbox and --provider; pick one (--sandbox is canonical).',
        )
        process.exit(2)
      }
      const sandbox = sandboxArg ?? providerLegacyArg
      const { runTopup } = await import('./commands/topup')
      await runTopup({ agent, compute, sandbox, vision })
      return
    }
    case 'model': {
      const { runModel } = await import('./commands/model')
      await runModel()
      return
    }
    case 'sync': {
      const { runSync } = await import('./commands/sync')
      await runSync()
      return
    }
    case 'profile': {
      // v0.23.0: `anima profile init` seeds user/profile.md if missing, derives
      // the operator-scoped PROFILE AES key, and either (sandbox) POSTs it to
      // /admin/profile-key or (local) runs a sync that anchors the slot.
      const profileSub = argv[1]
      if (profileSub === 'init') {
        const { runProfileInit } = await import('./commands/profile')
        await runProfileInit()
        return
      }
      console.error(
        `Unknown profile subcommand: ${profileSub ?? '(none)'} — try 'anima profile init'`,
      )
      process.exit(1)
      return
    }
    case 'migrate-keystore': {
      const { runMigrateKeystore } = await import('./commands/migrate-keystore')
      await runMigrateKeystore()
      return
    }
    case 'deploy': {
      const { runDeploy } = await import('./commands/deploy')
      await runDeploy()
      return
    }
    case 'upgrade': {
      const { parseUpgradeArgs, runUpgrade } = await import('./commands/upgrade')
      await runUpgrade(parseUpgradeArgs(argv.slice(1)))
      return
    }
    case 'resume': {
      const yes = argv.includes('--yes') || argv.includes('-y')
      const { runResume } = await import('./commands/resume')
      await runResume({ yes })
      return
    }
    case 'pause': {
      const yes = argv.includes('--yes') || argv.includes('-y')
      const { runPause } = await import('./commands/pause')
      await runPause({ yes })
      return
    }
    case 'ledger': {
      const sub = argv[1]
      const validSubs = ['balance', 'refund', 'retrieve', 'close'] as const
      type Sub = (typeof validSubs)[number]
      if (sub && !validSubs.includes(sub as Sub)) {
        console.error(
          `anima ledger: unknown subcommand '${sub}' (expected: ${validSubs.join(' | ')})`,
        )
        process.exit(1)
      }
      const chosen = (sub ?? 'balance') as Sub
      const amountIdx = argv.indexOf('--amount')
      const amount = amountIdx >= 0 ? Number(argv[amountIdx + 1]) : undefined
      const all = argv.includes('--all')
      const yes = argv.includes('--yes') || argv.includes('-y')
      const { runLedger } = await import('./commands/ledger')
      await runLedger({ sub: chosen, amount, all, yes })
      return
    }
    case 'balance': {
      const agentIdx = argv.indexOf('--agent')
      const agent = agentIdx >= 0 ? argv[agentIdx + 1] : undefined
      const { runBalance } = await import('./commands/balance')
      await runBalance({ agent })
      return
    }
    case 'drain': {
      const toIdx = argv.indexOf('--to')
      const to = toIdx >= 0 ? argv[toIdx + 1] : undefined
      const yes = argv.includes('--yes') || argv.includes('-y')
      const { runDrain } = await import('./commands/drain')
      await runDrain({ to, yes })
      return
    }
    case 'telegram': {
      const { parseTelegramArgs, runTelegram } = await import('./commands/telegram')
      const parsed = parseTelegramArgs(argv.slice(1))
      if ('error' in parsed) {
        console.error(`anima telegram: ${parsed.error}`)
        process.exit(1)
      }
      await runTelegram(parsed)
      return
    }
    case 'pairing': {
      const { parsePairingArgs, runPairing } = await import('./commands/pairing')
      const parsed = parsePairingArgs(argv.slice(1))
      if ('error' in parsed) {
        console.error(`anima pairing: ${parsed.error}`)
        process.exit(1)
      }
      await runPairing(parsed)
      return
    }
    case 'admin': {
      const { parseAdminArgs, runAdmin } = await import('./commands/admin')
      const parsed = parseAdminArgs(argv.slice(1))
      if ('error' in parsed) {
        console.error(`anima admin: ${parsed.error}`)
        process.exit(1)
      }
      await runAdmin(parsed)
      return
    }
    case 'gateway': {
      const { parseGatewayArgs, runGateway } = await import('./commands/gateway')
      const parsed = parseGatewayArgs(argv.slice(1))
      if ('error' in parsed) {
        console.error(`anima gateway: ${parsed.error}`)
        process.exit(1)
      }
      await runGateway(parsed)
      return
    }
    case 'inspect': {
      const { runInspect, isValidSlot } = await import('./commands/inspect')
      const remaining = argv.slice(1)
      const positional: string[] = []
      const flags: Record<string, string | boolean> = {}
      for (let i = 0; i < remaining.length; i++) {
        const a = remaining[i]!
        if (a === '--raw' || a === '--diff' || a === '--json' || a === '--full') {
          flags[a.slice(2)] = true
        } else if (a === '--slot' || a === '--tx' || a === '--out') {
          const v = remaining[++i]
          if (!v) {
            console.error(`anima inspect: ${a} requires a value`)
            process.exit(1)
          }
          flags[a.slice(2)] = v
        } else if (a.startsWith('--')) {
          console.error(`anima inspect: unknown flag ${a}`)
          process.exit(1)
        } else {
          positional.push(a)
        }
      }
      if (positional.length > 1) {
        console.error('anima inspect: at most one positional ref allowed')
        process.exit(1)
      }
      const slotFlag = flags.slot
      let slotName: import('@s0nderlabs/anima-core').IntelligentDataSlot | undefined
      if (typeof slotFlag === 'string') {
        if (!isValidSlot(slotFlag)) {
          console.error(
            'anima inspect: --slot must be one of memory-index, identity, persona, profile, keystore, activity-log',
          )
          process.exit(1)
        }
        slotName = slotFlag
      }
      const txFlag = flags.tx
      if (typeof txFlag === 'string' && !/^0x[0-9a-fA-F]{64}$/.test(txFlag)) {
        console.error('anima inspect: --tx must be a 32-byte hex hash')
        process.exit(1)
      }
      await runInspect({
        ref: positional[0],
        slot: slotName,
        tx: typeof txFlag === 'string' ? (txFlag as `0x${string}`) : undefined,
        raw: flags.raw === true,
        diff: flags.diff === true,
        json: flags.json === true,
        full: flags.full === true,
        out: typeof flags.out === 'string' ? flags.out : undefined,
      })
      return
    }
    case '-h':
    case '--help':
    case 'help': {
      printHelp()
      return
    }
    case '-v':
    case '--version':
    case 'version': {
      const { resolveCliVersion } = await import('./util/cli-version')
      const v = await resolveCliVersion()
      console.log(v)
      return
    }
    default: {
      console.log(`Unknown command: ${sub}`)
      printHelp()
      process.exit(1)
    }
  }
}

function printHelp(): void {
  console.log(
    [
      'anima: sovereign agent harness CLI',
      '',
      'Commands:',
      '  anima init                bootstrap a new agent identity + keystore',
      '  anima [--yolo]            interactive chat with your agent (default; --yolo skips approvals)',
      '  anima status              show agent + wallet + config state',
      '  anima logs                tail the activity log  (flags: --tail N, --agent <id>)',
      '  anima restore <ref>       recover an agent from an iNFT (ref: eip155:16661:0x..:N)',
      '  anima transfer <ref>      transfer iNFT to a new operator with re-encrypted keystore',
      '                            flags: --to <addr>, --recipient-key <hex>, --oracle-key <hex>,',
      '                                   --dry-run, --yes, --no-purge',
      '  anima topup               add funds  (flags: --agent N  --compute N  --sandbox N  --vision N)',
      '                            (--vision N seeds the 0G Compute vision provider sub-account)',
      '                            (--provider N is a deprecated alias for --sandbox)',
      '  anima ledger [sub]        compute ledger ops  (subs: balance | refund | retrieve | close)',
      '                            flags: --amount N  --all  --yes',
      '  anima balance             full economic position: EOA + compute ledger + sandbox billing reserve',
      "                            flags: --agent <addr>  (defaults to active config's agent)",
      '  anima drain --to <addr>   sweep agent EOA balance to address (default: operator)',
      '  anima model               re-pick the brain model',
      '  anima sync                force flush memory + activity-log to 0G + anchor on chain',
      '  anima migrate-keystore    upgrade v0.5.0 passphrase keystore to v0.6 operator-wallet',
      '  anima deploy              migrate Local agent to 0G Sandbox via Option 3 handoff',
      '  anima upgrade [<ref>]     roll harness to new ref in place (default: latest published release)',
      '                            flags: --ref vX.Y.Z, --reprovision for fresh container',
      '  anima resume              wake an archived/stopped sandbox (re-handoff agent privkey)',
      '  anima pause               archive sandbox to stop runtime burn (resume with: anima resume)',
      '  anima telegram <sub>      configure phone-DM gateway  (subs: setup | status | remove)',
      '                            flags: --yes (skip remove confirmation)',
      '  anima pairing <sub>       manage DM pairing approvals (subs: list | approve | revoke | clear-pending)',
      '                            usage: anima pairing approve telegram <code>',
      '  anima gateway <sub>       always-on agent gateway daemon  (subs: run | start | stop | restart | status | logs)',
      '                            run = foreground, start = bg + Touch ID, stop = SIGTERM via lock',
      '  anima admin <sub>         operator-only ops endpoints  (subs: autotopup-tick)',
      '                            autotopup-tick = live-fire AutoTopupManager poll cycle now',
      '  anima inspect [ref]       audit on-chain memory slots (flags: --slot, --tx, --raw, --diff, --json, --full, --out <dir>)',
      '  anima version             print CLI version  (aliases: --version, -v)',
      '  anima help                show this message  (aliases: --help, -h)',
      '',
    ].join('\n'),
  )
}

main()
  .then(() => {
    // Force-exit on success because some 0G SDKs (Storage Indexer, Compute
    // broker, WalletConnect relay) leak open handles (websockets, heartbeat
    // timers) that we don't have hooks to drain. Without this, one-shot
    // commands like `anima init` would hang at the prompt indefinitely after
    // their work completed. `chat` returns only when the user actually quits,
    // so this also gives chat a clean exit. Exit code 0 = normal success.
    process.exit(0)
  })
  .catch(e => {
    console.error('fatal:', (e as Error).message)
    process.exit(1)
  })
