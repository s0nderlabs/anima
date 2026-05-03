/**
 * CLI argv dispatch. Keeps phase 2 minimal: no subcommand → chat REPL,
 * otherwise route to commands/<name>.
 */

const argv = process.argv.slice(2)
// First arg starting with `--` means the user invoked the default subcommand
// (chat) with flags, e.g. `anima --yolo`. Treat it as if `chat` were implicit.
const sub = argv[0]?.startsWith('--') ? 'chat' : argv[0]

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
    case 'topup': {
      const agentIdx = argv.indexOf('--agent')
      const computeIdx = argv.indexOf('--compute')
      const providerIdx = argv.indexOf('--provider')
      const agent = agentIdx >= 0 ? Number(argv[agentIdx + 1]) : undefined
      const compute = computeIdx >= 0 ? Number(argv[computeIdx + 1]) : undefined
      const provider = providerIdx >= 0 ? Number(argv[providerIdx + 1]) : undefined
      const { runTopup } = await import('./commands/topup')
      await runTopup({ agent, compute, provider })
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
      const refIdx = argv.indexOf('--ref')
      const ref = refIdx >= 0 ? argv[refIdx + 1] : undefined
      const yes = argv.includes('--yes') || argv.includes('-y')
      const reprovision = argv.includes('--reprovision')
      const { runUpgrade } = await import('./commands/upgrade')
      await runUpgrade({ ref, yes, reprovision })
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
    case 'drain': {
      const toIdx = argv.indexOf('--to')
      const to = toIdx >= 0 ? argv[toIdx + 1] : undefined
      const yes = argv.includes('--yes') || argv.includes('-y')
      const { runDrain } = await import('./commands/drain')
      await runDrain({ to, yes })
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
      '  anima topup               add funds  (flags: --agent N  --compute N  --provider N)',
      '  anima ledger [sub]        compute ledger ops  (subs: balance | refund | retrieve | close)',
      '                            flags: --amount N  --all  --yes',
      '  anima drain --to <addr>   sweep agent EOA balance to address (default: operator)',
      '  anima model               re-pick the brain model',
      '  anima sync                force flush memory + activity-log to 0G + anchor on chain',
      '  anima migrate-keystore    upgrade v0.5.0 passphrase keystore to v0.6 operator-wallet',
      '  anima deploy              migrate Local agent to 0G Sandbox via Option 3 handoff',
      '  anima upgrade [--ref vX]  roll harness to new ref in place (flags: --reprovision for fresh container)',
      '  anima resume              wake an archived/stopped sandbox (re-handoff agent privkey)',
      '  anima pause               archive sandbox to stop runtime burn (resume with: anima resume)',
      '  anima inspect [ref]       audit on-chain memory slots (flags: --slot, --tx, --raw, --diff, --json, --full, --out <dir>)',
      '  anima help                show this message',
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
