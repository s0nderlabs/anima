/**
 * The ~70 tools the brain can call, grouped by category.
 * Used by Section 2 V5 (Limbs grid).
 */

export type Tool = { name: string; desc: string }
export type ToolCategory = { label: string; tools: Tool[] }

export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    label: 'fs',
    tools: [
      { name: 'fs.read', desc: 'read a file from disk' },
      { name: 'fs.write', desc: 'write a file to disk' },
      { name: 'fs.patch', desc: 'apply a substring patch to a file' },
      { name: 'fs.search', desc: 'glob + ripgrep across a directory tree' },
    ],
  },
  {
    label: 'shell',
    tools: [
      { name: 'shell.run', desc: 'execute a shell command (sandboxed)' },
      { name: 'shell.cd', desc: 'change working directory' },
      { name: 'shell.process_start', desc: 'start a long-lived background process' },
      { name: 'shell.process_output', desc: 'read output from a running process' },
      { name: 'shell.process_list', desc: 'list active background processes' },
      { name: 'shell.process_kill', desc: 'terminate a background process' },
    ],
  },
  {
    label: 'browser',
    tools: [
      { name: 'browser.navigate', desc: 'load a URL' },
      { name: 'browser.snapshot', desc: 'capture accessibility tree' },
      { name: 'browser.click', desc: 'click an element' },
      { name: 'browser.type', desc: 'type text into a field' },
      { name: 'browser.scroll', desc: 'scroll page or element' },
      { name: 'browser.press', desc: 'press a key' },
      { name: 'browser.back', desc: 'navigate back in history' },
      { name: 'browser.get_images', desc: 'extract images from page' },
      { name: 'browser.console', desc: 'read browser console output' },
      { name: 'browser.vision', desc: 'describe what is on screen' },
    ],
  },
  {
    label: 'chain',
    tools: [
      { name: 'chain.balance', desc: 'read EOA balance' },
      { name: 'chain.send', desc: 'send native 0G' },
      { name: 'chain.wrap', desc: 'wrap 0G to W0G' },
      { name: 'chain.unwrap', desc: 'unwrap W0G to 0G' },
      { name: 'chain.read', desc: 'call contract view function' },
      { name: 'chain.write', desc: 'call contract write function' },
      { name: 'chain.block', desc: 'read block details' },
      { name: 'chain.gas', desc: 'estimate gas / current price' },
      { name: 'chain.tx', desc: 'fetch tx receipt' },
      { name: 'chain.contract', desc: 'inspect contract bytecode + ABI' },
      { name: 'chain.activity', desc: 'recent EOA activity feed' },
    ],
  },
  {
    label: 'swap+stake',
    tools: [
      { name: 'swap.quote', desc: 'JAINE swap quote' },
      { name: 'swap.execute', desc: 'JAINE swap execution' },
      { name: 'stake.stake', desc: 'stake into Gimo position' },
      { name: 'stake.unstake', desc: 'unstake from Gimo' },
      { name: 'stake.claim', desc: 'claim rewards' },
      { name: 'stake.position', desc: 'read current position' },
      { name: 'tokens.info', desc: 'token metadata + price' },
    ],
  },
  {
    label: 'comms',
    tools: [
      { name: 'agent.message', desc: 'send ECIES-encrypted message via AnimaInbox' },
      { name: 'agent.sendFile', desc: 'send encrypted file' },
      { name: 'agent.fetchFile', desc: 'fetch encrypted file' },
      { name: 'agent.history', desc: 'inbox history' },
      { name: 'contacts.list', desc: 'show contacts + presence' },
      { name: 'contacts.add', desc: 'approve a contact' },
      { name: 'contacts.remove', desc: 'remove a contact' },
      { name: 'contacts.block', desc: 'block an address' },
      { name: 'contacts.mute', desc: 'mute notifications' },
      { name: 'contacts.unmute', desc: 'unmute notifications' },
      { name: 'presence.set', desc: 'set online status' },
    ],
  },
  {
    label: 'market',
    tools: [
      { name: 'market.list', desc: 'browse open jobs' },
      { name: 'market.createJob', desc: 'post a job with escrow' },
      { name: 'market.markDone', desc: 'provider marks complete' },
      { name: 'market.acceptResult', desc: 'buyer accepts + settles' },
      { name: 'market.dispute', desc: 'open a dispute' },
      { name: 'market.proposeSplit', desc: 'propose split settlement' },
      { name: 'market.claimTimeout', desc: 'claim after timeout' },
      { name: 'market.forceClose', desc: 'force-close a job' },
      { name: 'market.getJob', desc: 'read job state' },
    ],
  },
  {
    label: 'account',
    tools: [
      { name: 'account.info', desc: 'agent identity, iNFT, owner' },
      { name: 'account.balance', desc: 'aggregate EOA + compute + sandbox' },
    ],
  },
  {
    label: 'memory',
    tools: [
      { name: 'memory.save', desc: 'write to /agent or /user partition' },
      { name: 'memory.read', desc: 'read a memory file' },
    ],
  },
  {
    label: 'skills',
    tools: [
      { name: 'skills.list', desc: 'available skills' },
      { name: 'skills.view', desc: 'read a skill body' },
      { name: 'skills.manage', desc: 'enable/disable skills' },
    ],
  },
  {
    label: 'meta',
    tools: [
      { name: 'code.execute', desc: 'sandboxed python/node eval' },
      { name: 'vision.analyze', desc: 'image understanding' },
      { name: 'delegate.task', desc: 'spawn a subagent' },
      { name: 'session.search', desc: 'recall past tool calls' },
      { name: 'web.fetch', desc: 'plain HTTP fetch' },
      { name: 'todo', desc: 'task tracking' },
      { name: 'clarify', desc: 'ask the operator a question' },
      { name: 'tool.search', desc: 'discover deferred tools' },
    ],
  },
]

export const TOTAL_TOOL_COUNT = TOOL_CATEGORIES.reduce((acc, cat) => acc + cat.tools.length, 0)
