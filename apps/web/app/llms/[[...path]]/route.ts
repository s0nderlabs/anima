import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { NextRequest } from 'next/server'
import { type Doc, getDoc, listDocs, listSlugs } from '@/lib/docs'

export const runtime = 'nodejs'
export const dynamic = 'force-static'

export async function generateStaticParams() {
  const slugs = await listSlugs()
  return [
    { path: [] },
    { path: ['full'] },
    ...slugs.map(slug => ({ path: ['docs', slug] })),
  ]
}

const SITE_ORIGIN = 'https://anima.s0nderlabs.xyz'
const REPO_BASE = 'https://github.com/s0nderlabs/anima/blob/main/'

const TEXT_HEADERS = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
  'X-Anima-Source': 'docs-llms',
}

const FULL_ORDER = [
  'agents',
  'quickstart',
  'configuration',
  'cli',
  'brain',
  'tools',
  'memory',
  'architecture',
  'identity',
  'console',
  'introduction',
]

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
) {
  const { path: parts = [] } = await context.params

  if (parts.length === 0) {
    return text(await renderLlmsIndex())
  }
  if (parts.length === 1 && parts[0] === 'full') {
    return text(await renderLlmsFull())
  }
  if (parts.length === 2 && parts[0] === 'docs') {
    const body = await renderDocRaw(parts[1])
    if (body === null) return notFound()
    return text(body)
  }
  return notFound()
}

function text(body: string): Response {
  return new Response(body, { status: 200, headers: TEXT_HEADERS })
}

function notFound(): Response {
  return new Response('not found\n', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

async function renderLlmsIndex(): Promise<string> {
  const docs = await listDocs()
  const docBullets = docs
    .map(
      d =>
        `- [${d.frontmatter.title}](${SITE_ORIGIN}/docs/${d.frontmatter.slug}.md): ${d.frontmatter.description}`,
    )
    .join('\n')

  return `# anima

> First fully on-chain sovereign agent harness on 0G. CLI-hosted agent with identity (ERC-7857 iNFT), memory (0G Storage), brain (0G Compute TeeML), and wallet anchored to 0G's decentralized infrastructure. Operator runs \`anima init\` once; the agent persists on chain and survives operator death.

## Install

bun is REQUIRED. The CLI shebangs \`#!/usr/bin/env bun\`. \`npm install -g\` puts the binary on PATH but it exits at runtime without bun.

\`\`\`
curl -fsSL https://bun.sh/install | bash
bun add -g @s0nderlabs/anima
anima init
\`\`\`

Current version: 0.24.17. Requires bun >=1.1. Published as \`@s0nderlabs/anima\` on npm; binary name is \`anima\`.

## For AI agents

\`anima init\` is interactive (8 blocking prompts, no env-var bypass except \`ANIMA_OPERATOR_PRIVKEY\`). Two paths: guide the human through the wizard, OR puppet the TUI via \`tmux send-keys\` if you have shell access (Claude Code, Codex). Naive \`echo y | anima init\` will hang. No one-shot chat mode; drive the TUI in tmux or hit the standalone gateway daemon. Full install model, anti-patterns, common errors, state layout: ${SITE_ORIGIN}/docs/agents.md

- Full single-file dump: ${SITE_ORIGIN}/llms-full.txt
- Per-page raw markdown: ${SITE_ORIGIN}/docs/<slug>.md (e.g. ${SITE_ORIGIN}/docs/quickstart.md)

## Docs

${docBullets}

## Reference

- README: https://github.com/s0nderlabs/anima#readme
- Console: ${SITE_ORIGIN}/console
- Releases: https://github.com/s0nderlabs/anima/releases
- Networks: mainnet chainId 16661 (https://evmrpc.0g.ai), testnet Galileo chainId 16602 (https://evmrpc-testnet.0g.ai)
- AnimaAgentNFT (ERC-7857): 0x9e71d79f06f956d4d2666b5c93dafab721c84721 (mainnet + Galileo testnet via CREATE2)
- AnimaSubnameRegistrar: 0x33d9f4ec2bd7e7cb4e288c3bbc3a76be472fdd98 (mainnet)
- AnimaInbox: 0xcd92844cc0ec6Be0607B330D4BaCC707339f2589 (mainnet)
- AnimaMarket: 0x3ebD21f5dd67acDeF199fACF28388627212bA2aB (mainnet)
`
}

async function renderLlmsFull(): Promise<string> {
  const [docs, readme] = await Promise.all([listDocs(), readReadme()])
  const docBySlug = new Map(docs.map(d => [d.frontmatter.slug, d]))

  const header = `# anima — full machine-readable docs

> First fully on-chain sovereign agent harness on 0G. This file inlines every documentation page plus the repo README. Sections separated by horizontal rules. Each doc body is preceded by a source pointer when frontmatter declares one.

> Single most common install failure: bun must be installed FIRST. The CLI shebangs \`#!/usr/bin/env bun\`. \`npm install -g\` succeeds and the binary lands on PATH, but it exits at runtime with \`env: bun: No such file or directory\`. Always run \`curl -fsSL https://bun.sh/install | bash\` then \`bun add -g @s0nderlabs/anima\`.

> \`anima init\` is interactive. Eight blocking @clack/prompts selects with no env-var bypass (except \`ANIMA_OPERATOR_PRIVKEY\`). Two completion paths from an agent: guide the human, or puppet the TUI with \`tmux send-keys\` if you have shell access. Naive stdin piping fails because @clack checks for a real TTY.

Current version: 0.24.17. Binary name: \`anima\`. Engine: bun >=1.1.`

  const sections: string[] = [header]

  sections.push(`## README\n\n${sourceBlock('README.md')}${readme.trim()}`)

  const seen = new Set<string>()
  for (const slug of FULL_ORDER) {
    const d = docBySlug.get(slug)
    if (!d) continue
    sections.push(renderDocSection(d))
    seen.add(slug)
  }
  for (const d of docs) {
    if (seen.has(d.frontmatter.slug)) continue
    sections.push(renderDocSection(d))
  }

  return `${sections.join('\n\n---\n\n')}\n`
}

function sourceBlock(source: string | undefined): string {
  return source ? `> Source: ${REPO_BASE}${source}\n\n` : ''
}

function renderDocSection(d: Doc): string {
  return `## ${d.frontmatter.title}\n\n${sourceBlock(d.frontmatter.source)}${d.content.trim()}`
}

async function renderDocRaw(slug: string): Promise<string | null> {
  const doc = await getDoc(slug)
  if (!doc) return null
  return `${sourceBlock(doc.frontmatter.source)}${doc.content.trim()}`
}

async function readReadme(): Promise<string> {
  const readmePath = path.join(process.cwd(), '..', '..', 'README.md')
  try {
    return await fs.readFile(readmePath, 'utf8')
  } catch {
    return '# anima\n\nREADME not bundled in this build. Read it at https://github.com/s0nderlabs/anima#readme'
  }
}
