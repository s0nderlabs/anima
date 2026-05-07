import { expect, test } from 'bun:test'
import {
  type EscalationDeps,
  type FetchEscalation,
  detectFetchEscalation,
  mergeEscalationResult,
  runEscalation,
} from './escalation'
import type { ToolCall, ToolResult } from './types'

const fetchCall = (id: string, url: string): ToolCall => ({
  id,
  name: 'web.fetch',
  args: { url },
})

const blockedResult = (final_url: string, reason: string): ToolResult => ({
  ok: true,
  data: {
    status: 200,
    content_type: 'text/html',
    body: '# unusual traffic from your computer network\n\nplease show you are not a robot',
    truncated: false,
    final_url,
    blocked: true,
    block_reason: reason,
  },
})

const escalationFor = (call: ToolCall, reason: string, url: string): FetchEscalation => ({
  needed: true,
  escalatedCall: { id: `auto-escalate-${call.id}`, name: 'browser.navigate', args: { url } },
  reason,
  url,
})

test('detect: web.fetch + blocked + final_url returns needed with escalated call', () => {
  const call = fetchCall('c1', 'https://www.google.com/search?q=test')
  const result = blockedResult('https://www.google.com/search?q=test', 'google-bot-block')
  const out = detectFetchEscalation(call, result)
  expect(out.needed).toBe(true)
  expect(out.escalatedCall?.id).toBe('auto-escalate-c1')
  expect(out.escalatedCall?.name).toBe('browser.navigate')
  expect(out.escalatedCall?.args).toEqual({ url: 'https://www.google.com/search?q=test' })
  expect(out.reason).toBe('google-bot-block')
  expect(out.url).toBe('https://www.google.com/search?q=test')
})

test('detect: blocked + no final_url falls back to call.args.url', () => {
  const call = fetchCall('c2', 'https://example.com/blocked')
  const result: ToolResult = {
    ok: true,
    data: { blocked: true, block_reason: 'cloudflare', body: 'Just a moment...' },
  }
  const out = detectFetchEscalation(call, result)
  expect(out.needed).toBe(true)
  expect(out.escalatedCall?.args).toEqual({ url: 'https://example.com/blocked' })
})

test('detect: blocked + neither final_url nor args.url returns not needed', () => {
  const call: ToolCall = { id: 'c3', name: 'web.fetch', args: {} }
  const result: ToolResult = { ok: true, data: { blocked: true, block_reason: 'captcha' } }
  expect(detectFetchEscalation(call, result).needed).toBe(false)
})

test('detect: v0.21.3 — timeout failure DOES escalate (transient)', () => {
  const call = fetchCall('c4', 'https://arxiv.org/search/?query=test')
  const result: ToolResult = { ok: false, error: 'timeout after 15000ms' }
  const out = detectFetchEscalation(call, result)
  expect(out.needed).toBe(true)
  expect(out.reason).toBe('timeout')
  expect(out.escalatedCall?.args).toEqual({ url: 'https://arxiv.org/search/?query=test' })
})

test('detect: v0.21.3 — http 503 failure DOES escalate', () => {
  const call = fetchCall('c4b', 'https://flaky.example.com')
  const result: ToolResult = { ok: false, error: 'http 503' }
  const out = detectFetchEscalation(call, result)
  expect(out.needed).toBe(true)
  expect(out.reason).toBe('http-503')
})

test('detect: v0.21.3 — http 429 failure DOES escalate', () => {
  const call = fetchCall('c4c', 'https://api.example.com')
  const result: ToolResult = { ok: false, error: 'http 429' }
  const out = detectFetchEscalation(call, result)
  expect(out.needed).toBe(true)
  expect(out.reason).toBe('http-429')
})

test('detect: v0.21.3 — DNS failure DOES escalate', () => {
  const call = fetchCall('c4d', 'https://dns-broken.example')
  const result: ToolResult = {
    ok: false,
    error: 'getaddrinfo ENOTFOUND dns-broken.example',
  }
  const out = detectFetchEscalation(call, result)
  expect(out.needed).toBe(true)
  expect(out.reason).toBe('dns')
})

test('detect: v0.21.3 — connection refused DOES escalate', () => {
  const call = fetchCall('c4e', 'https://refused.example.com')
  const result: ToolResult = { ok: false, error: 'connect ECONNREFUSED' }
  const out = detectFetchEscalation(call, result)
  expect(out.needed).toBe(true)
  expect(out.reason).toBe('connection')
})

test('detect: v0.21.3 — generic fetch failure DOES escalate', () => {
  const call = fetchCall('c4f', 'https://example.com')
  const result: ToolResult = { ok: false, error: 'fetch failed' }
  const out = detectFetchEscalation(call, result)
  expect(out.needed).toBe(true)
  expect(out.reason).toBe('fetch-error')
})

test('detect: v0.21.3 — invalid URL is permanent, does NOT escalate', () => {
  const call: ToolCall = { id: 'c4g', name: 'web.fetch', args: { url: 'not a url' } }
  const result: ToolResult = { ok: false, error: 'invalid URL' }
  expect(detectFetchEscalation(call, result).needed).toBe(false)
})

test('detect: v0.21.3 — unsupported protocol is permanent, does NOT escalate', () => {
  const call = fetchCall('c4h', 'file:///etc/passwd')
  const result: ToolResult = { ok: false, error: 'unsupported protocol: file:' }
  expect(detectFetchEscalation(call, result).needed).toBe(false)
})

test('detect: v0.21.3 — host blocked (private IP) is permanent, does NOT escalate', () => {
  const call = fetchCall('c4i', 'http://169.254.169.254/latest/meta-data')
  const result: ToolResult = {
    ok: false,
    error: 'host blocked (private/loopback/metadata): 169.254.169.254',
  }
  expect(detectFetchEscalation(call, result).needed).toBe(false)
})

test('detect: web.fetch ok with no blocked field returns not needed', () => {
  const call = fetchCall('c5', 'https://news.ycombinator.com')
  const result: ToolResult = {
    ok: true,
    data: { status: 200, body: '# Hacker News', final_url: 'https://news.ycombinator.com' },
  }
  expect(detectFetchEscalation(call, result).needed).toBe(false)
})

test('detect: non-web.fetch tool with blocked:true returns not needed', () => {
  const call: ToolCall = { id: 'c6', name: 'shell.run', args: { command: 'ls' } }
  const result: ToolResult = { ok: true, data: { blocked: true, block_reason: 'spurious' } }
  expect(detectFetchEscalation(call, result).needed).toBe(false)
})

test('detect: web.fetch with missing data field + ok=true returns not needed', () => {
  const call = fetchCall('c7', 'https://x.com')
  const result: ToolResult = { ok: true }
  expect(detectFetchEscalation(call, result).needed).toBe(false)
})

test('detect: web.fetch missing block_reason still escalates with reason "unknown"', () => {
  const call = fetchCall('c8', 'https://x.com')
  const result: ToolResult = {
    ok: true,
    data: { blocked: true, final_url: 'https://x.com' },
  }
  const out = detectFetchEscalation(call, result)
  expect(out.needed).toBe(true)
  expect(out.reason).toBe('unknown')
})

test('detect: tail-recursion guard refuses to escalate already-escalated calls', () => {
  const call: ToolCall = {
    id: 'auto-escalate-original',
    name: 'web.fetch',
    args: { url: 'https://x.com' },
  }
  const result = blockedResult('https://x.com', 'cloudflare')
  expect(detectFetchEscalation(call, result).needed).toBe(false)
})

test('detect: v0.21.3 — failure with no URL anywhere does NOT escalate', () => {
  const call: ToolCall = { id: 'c9', name: 'web.fetch', args: {} }
  const result: ToolResult = { ok: false, error: 'timeout after 15000ms' }
  expect(detectFetchEscalation(call, result).needed).toBe(false)
})

test('merge: ok escalation produces ok=true result with both blobs', () => {
  const original = blockedResult('https://www.google.com', 'google-bot-block')
  const escalated: ToolResult = {
    ok: true,
    data: { currentUrl: 'https://www.google.com', title: 'Google' },
  }
  const escalation = escalationFor(
    fetchCall('c9', 'https://www.google.com'),
    'google-bot-block',
    'https://www.google.com',
  )
  const merged = mergeEscalationResult(original, escalated, escalation)
  expect(merged.ok).toBe(true)
  const data = merged.data as Record<string, unknown>
  expect(data.blocked).toBe(true)
  expect(data.body).toContain('unusual traffic')
  const ae = data.auto_escalation as Record<string, unknown>
  expect(ae.triggered).toBe(true)
  expect(ae.from).toBe('web.fetch')
  expect(ae.to).toBe('browser.navigate')
  expect(ae.reason).toBe('google-bot-block')
  expect(ae.url).toBe('https://www.google.com')
  const aeResult = ae.result as ToolResult
  expect(aeResult.ok).toBe(true)
  expect((aeResult.data as Record<string, unknown>).title).toBe('Google')
})

test('merge: v0.21.3 — timeout escalation preserves original error', () => {
  const original: ToolResult = { ok: false, error: 'timeout after 15000ms' }
  const escalated: ToolResult = { ok: true, data: { currentUrl: 'https://arxiv.org/search' } }
  const escalation = escalationFor(
    fetchCall('cT', 'https://arxiv.org/search'),
    'timeout',
    'https://arxiv.org/search',
  )
  const merged = mergeEscalationResult(original, escalated, escalation)
  expect(merged.ok).toBe(true)
  const data = merged.data as Record<string, unknown>
  const ae = data.auto_escalation as Record<string, unknown>
  expect(ae.reason).toBe('timeout')
  expect(ae.original_error).toBe('timeout after 15000ms')
})

test('merge: failed escalation sets ok=false with descriptive error, preserves original data', () => {
  const original = blockedResult('https://www.google.com', 'google-bot-block')
  const escalated: ToolResult = {
    ok: false,
    error: 'Unknown tool: browser.navigate',
  }
  const escalation = escalationFor(
    fetchCall('c10', 'https://www.google.com'),
    'google-bot-block',
    'https://www.google.com',
  )
  const merged = mergeEscalationResult(original, escalated, escalation)
  expect(merged.ok).toBe(false)
  expect(merged.error).toContain('auto-escalation failed')
  expect(merged.error).toContain('Unknown tool: browser.navigate')
  const data = merged.data as Record<string, unknown>
  expect(data.blocked).toBe(true)
  expect(data.body).toContain('unusual traffic')
  const ae = data.auto_escalation as Record<string, unknown>
  expect((ae.result as ToolResult).ok).toBe(false)
})

test('merge: failed escalation with no error field still produces fallback message', () => {
  const original = blockedResult('https://x.com', 'cloudflare')
  const escalated: ToolResult = { ok: false }
  const escalation = escalationFor(fetchCall('c11', 'https://x.com'), 'cloudflare', 'https://x.com')
  const merged = mergeEscalationResult(original, escalated, escalation)
  expect(merged.error).toBe('auto-escalation failed: unknown')
})

test('merge: missing original.data handled defensively (no throw, escalation block still set)', () => {
  const original: ToolResult = { ok: true }
  const escalated: ToolResult = { ok: true, data: { currentUrl: 'https://x.com' } }
  const escalation = escalationFor(fetchCall('c12', 'https://x.com'), 'rate-limit', 'https://x.com')
  const merged = mergeEscalationResult(original, escalated, escalation)
  expect(merged.ok).toBe(true)
  const data = merged.data as Record<string, unknown>
  expect(data.auto_escalation).toBeDefined()
  const ae = data.auto_escalation as Record<string, unknown>
  expect(ae.reason).toBe('rate-limit')
})

interface CallLog {
  pre: ToolCall[]
  post: Array<{ call: ToolCall; result: ToolResult }>
  dispatch: ToolCall[]
  activity: Array<{ call: ToolCall; result: ToolResult }>
  starts: ToolCall[]
  ends: Array<{ call: ToolCall; result: ToolResult; durationMs: number }>
}

const captureDeps = (
  log: CallLog,
  dispatchResult: ToolResult,
  preShort?: ToolResult,
): EscalationDeps => ({
  runPreCall: async call => {
    log.pre.push(call)
    return preShort ? { short: preShort } : {}
  },
  runPostCall: async (call, result) => {
    log.post.push({ call, result })
  },
  dispatch: async call => {
    log.dispatch.push(call)
    return dispatchResult
  },
  appendActivity: async (call, result) => {
    log.activity.push({ call, result })
  },
  onStart: call => {
    log.starts.push(call)
  },
  onEnd: (call, result, durationMs) => {
    log.ends.push({ call, result, durationMs })
  },
})

test('runEscalation: passes through original when escalation not needed', async () => {
  const log: CallLog = { pre: [], post: [], dispatch: [], activity: [], starts: [], ends: [] }
  const original: ToolResult = { ok: true, data: { body: 'fine' } }
  const out = await runEscalation({ needed: false }, original, captureDeps(log, { ok: true }))
  expect(out).toBe(original)
  expect(log.starts.length).toBe(0)
  expect(log.dispatch.length).toBe(0)
})

test('runEscalation: ok escalation runs full pipeline + emits start/end + merges', async () => {
  const log: CallLog = { pre: [], post: [], dispatch: [], activity: [], starts: [], ends: [] }
  const original = blockedResult('https://x.com', 'cloudflare')
  const escalation = escalationFor(fetchCall('c13', 'https://x.com'), 'cloudflare', 'https://x.com')
  const escalated: ToolResult = { ok: true, data: { currentUrl: 'https://x.com' } }
  const merged = await runEscalation(escalation, original, captureDeps(log, escalated))
  expect(log.starts.length).toBe(1)
  expect(log.starts[0]?.name).toBe('browser.navigate')
  expect(log.pre.length).toBe(1)
  expect(log.dispatch.length).toBe(1)
  expect(log.post.length).toBe(1)
  expect(log.activity.length).toBe(1)
  expect(log.ends.length).toBe(1)
  expect(typeof log.ends[0]?.durationMs).toBe('number')
  expect(merged.ok).toBe(true)
  const ae = (merged.data as Record<string, unknown>).auto_escalation as Record<string, unknown>
  expect(ae.triggered).toBe(true)
})

test('runEscalation: pre-hook short-circuit skips dispatch + post-hook', async () => {
  const log: CallLog = { pre: [], post: [], dispatch: [], activity: [], starts: [], ends: [] }
  const original = blockedResult('https://x.com', 'cloudflare')
  const escalation = escalationFor(fetchCall('c14', 'https://x.com'), 'cloudflare', 'https://x.com')
  const denied: ToolResult = { ok: false, error: 'denied by approval' }
  const merged = await runEscalation(escalation, original, captureDeps(log, { ok: true }, denied))
  expect(log.dispatch.length).toBe(0)
  expect(log.post.length).toBe(0)
  expect(log.activity.length).toBe(1)
  expect(log.activity[0]?.result.ok).toBe(false)
  expect(merged.ok).toBe(false)
  expect(merged.error).toContain('auto-escalation failed')
})
