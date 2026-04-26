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
      const agent = agentIdx >= 0 ? Number(argv[agentIdx + 1]) : undefined
      const compute = computeIdx >= 0 ? Number(argv[computeIdx + 1]) : undefined
      const { runTopup } = await import('./commands/topup')
      await runTopup({ agent, compute })
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
      'anima: sovereign agent runtime CLI',
      '',
      'Commands:',
      '  anima init                bootstrap a new agent identity + keystore',
      '  anima [--yolo]            interactive chat with your agent (default; --yolo skips approvals)',
      '  anima status              show agent + wallet + config state',
      '  anima logs                tail the activity log  (flags: --tail N, --agent <id>)',
      '  anima restore <ref>       recover an agent from an iNFT (ref: eip155:16661:0x..:N)',
      '  anima topup               add funds  (flags: --agent N  --compute N)',
      '  anima model               re-pick the brain model',
      '  anima sync                force flush memory + activity-log to 0G + anchor on chain',
      '  anima migrate-keystore    upgrade v0.5.0 passphrase keystore to v0.6 operator-wallet',
      '  anima deploy              migrate Local agent to 0G Sandbox via Option 3 handoff',
      '  anima help                show this message',
      '',
    ].join('\n'),
  )
}

main().catch(e => {
  console.error('fatal:', (e as Error).message)
  process.exit(1)
})
