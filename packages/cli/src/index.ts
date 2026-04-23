/**
 * CLI argv dispatch. Keeps phase 2 minimal: no subcommand → chat REPL,
 * otherwise route to commands/<name>.
 */

const argv = process.argv.slice(2)
const sub = argv[0]

async function main(): Promise<void> {
  switch (sub) {
    case undefined:
    case 'chat': {
      const { runChat } = await import('./commands/chat')
      await runChat()
      return
    }
    case 'init': {
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
      'anima — sovereign agent runtime CLI',
      '',
      'Commands:',
      '  anima init          bootstrap a new agent identity + keystore',
      '  anima               interactive chat with your agent (default)',
      '  anima status        show agent + wallet + config state',
      '  anima logs          tail the activity log  (flags: --tail N, --agent <id>)',
      '  anima help          show this message',
      '',
    ].join('\n'),
  )
}

main().catch(e => {
  console.error('fatal:', (e as Error).message)
  process.exit(1)
})
