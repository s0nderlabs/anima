'use client'

import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

// Slots whose content is rendered as its own in-page panel by MemoryBrowser.
// Memory-index markdown links like `[identity](agent/identity.md)` should
// smooth-scroll to that panel instead of issuing a route navigation.
const INLINE_SLOT_ANCHORS: Record<string, string> = {
  'agent/identity.md': 'mem-identity',
  'agent/persona.md': 'mem-persona',
  'agent/profile.md': 'mem-profile',
  'user/profile.md': 'mem-profile',
}

function resolveInPageAnchor(href: string | undefined): string | null {
  if (!href) return null
  const clean = href.replace(/^\.?\//, '')
  return INLINE_SLOT_ANCHORS[clean] ?? null
}

function isExternalUrl(href: string | undefined): boolean {
  if (!href) return false
  return /^(https?:)?\/\//.test(href) || href.startsWith('mailto:')
}

const components: Components = {
  h1: ({ children }) => (
    <h1
      className="mb-5 mt-7 font-display text-[clamp(28px,3vw,40px)] font-light leading-[1.08] tracking-tight text-[var(--color-ink)] first:mt-0"
      style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0' }}
    >
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2
      className="mb-4 mt-8 font-display text-[clamp(22px,2.4vw,30px)] font-light leading-[1.1] tracking-tight text-[var(--color-ink)] first:mt-0"
      style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0' }}
    >
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-3 mt-6 text-[19px] font-medium leading-[1.2] tracking-tight text-[var(--color-ink)] first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-2 mt-5 text-[16px] font-medium leading-[1.25] tracking-tight text-[var(--color-ink)] first:mt-0">
      {children}
    </h4>
  ),
  p: ({ children }) => (
    <p className="mb-4 text-[16px] leading-[1.75] text-[var(--color-ink)] [&_strong]:font-medium [&_strong]:text-[var(--color-ink)]">
      {children}
    </p>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-5 border-l-2 border-[var(--color-border-strong)] pl-4 font-italic-serif text-[20px] italic leading-[1.55] text-[var(--color-ink-2)]">
      {children}
    </blockquote>
  ),
  ul: ({ children }) => (
    <ul className="mb-4 ml-5 list-disc space-y-1.5 text-[16px] leading-[1.65] text-[var(--color-ink)] marker:text-[var(--color-ink-3)]">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-4 ml-5 list-decimal space-y-1.5 text-[16px] leading-[1.65] text-[var(--color-ink)] marker:text-[var(--color-ink-3)]">
      {children}
    </ol>
  ),
  li: ({ children }) => <li>{children}</li>,
  a: ({ href, children }) => {
    const anchor = resolveInPageAnchor(href)
    if (anchor) {
      return (
        <a
          href={`#${anchor}`}
          onClick={e => {
            e.preventDefault()
            document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }}
          className="text-[var(--color-ink)] underline decoration-[var(--color-border-strong)] underline-offset-[3px] transition hover:decoration-[var(--color-ink)]"
        >
          {children}
        </a>
      )
    }
    if (isExternalUrl(href)) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--color-ink)] underline decoration-[var(--color-border-strong)] underline-offset-[3px] transition hover:decoration-[var(--color-ink)]"
        >
          {children}
        </a>
      )
    }
    // Relative path to a memory file we can't reach from the browser
    // (lives in the operator's local /user/ partition, never anchored on-chain).
    return (
      <span
        title="Stored only on the operator's device. Not on chain."
        className="text-[var(--color-ink-2)] underline decoration-dotted decoration-[var(--color-border-strong)] underline-offset-[3px]"
      >
        {children}
      </span>
    )
  },
  code: ({ children, className }) => {
    if (!className) {
      return (
        <code className="rounded bg-[var(--color-paper)] px-1.5 py-0.5 font-mono text-[13.5px] text-[var(--color-ink)]">
          {children}
        </code>
      )
    }
    return <code className={className}>{children}</code>
  },
  pre: ({ children }) => (
    <pre className="my-5 overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-paper)] px-5 py-4 font-mono text-[13.5px] leading-[1.55] text-[var(--color-ink)]">
      {children}
    </pre>
  ),
  hr: () => <hr className="my-8 border-[var(--color-border)]" />,
  strong: ({ children }) => (
    <strong className="font-medium text-[var(--color-ink)]">{children}</strong>
  ),
  em: ({ children }) => (
    <em className="font-italic-serif italic text-[var(--color-ink)]">{children}</em>
  ),
}

export function MarkdownView({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      rehypePlugins={[rehypeSanitize]}
      components={components}
    >
      {content}
    </ReactMarkdown>
  )
}
