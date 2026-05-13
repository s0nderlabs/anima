'use client'

import { Children, isValidElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { CopyButton } from './CopyButton'
import { TreeBlock } from './TreeBlock'

function flattenText(node: ReactNode): string {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenText).join('')
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode }
    return flattenText(props.children)
  }
  return ''
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

function isExternalUrl(href: string | undefined): boolean {
  if (!href) return false
  return /^(https?:)?\/\//.test(href) || href.startsWith('mailto:')
}

function HeadingAnchor({ id }: { id: string }) {
  return (
    <a
      href={`#${id}`}
      aria-label="Anchor"
      className="font-mono ml-2 text-[var(--color-ink-3)] opacity-0 transition group-hover:opacity-100"
      onClick={e => {
        e.preventDefault()
        const target = document.getElementById(id)
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
        history.replaceState(null, '', `#${id}`)
      }}
    >
      #
    </a>
  )
}

const components: Components = {
  h1: ({ children }) => {
    const id = slugify(flattenText(children))
    return (
      <h1
        id={id}
        className="group mb-6 mt-2 scroll-mt-32 font-display text-[clamp(32px,3.6vw,46px)] font-light leading-[1.06] tracking-[-0.016em] text-[var(--color-ink)]"
        style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0' }}
      >
        {children}
        <HeadingAnchor id={id} />
      </h1>
    )
  },
  h2: ({ children }) => {
    const id = slugify(flattenText(children))
    return (
      <h2
        id={id}
        className="group mb-4 mt-12 scroll-mt-32 font-display text-[clamp(22px,2.4vw,30px)] font-light leading-[1.12] tracking-tight text-[var(--color-ink)]"
        style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30, "WONK" 0' }}
      >
        {children}
        <HeadingAnchor id={id} />
      </h2>
    )
  },
  h3: ({ children }) => {
    const id = slugify(flattenText(children))
    return (
      <h3
        id={id}
        className="group mb-3 mt-8 scroll-mt-32 text-[18px] font-medium leading-[1.25] tracking-tight text-[var(--color-ink)]"
      >
        {children}
        <HeadingAnchor id={id} />
      </h3>
    )
  },
  h4: ({ children }) => (
    <h4 className="mb-2 mt-6 text-[15.5px] font-medium leading-[1.3] tracking-tight text-[var(--color-ink)]">
      {children}
    </h4>
  ),
  p: ({ children }) => (
    <p className="mb-5 text-[16px] leading-[1.75] text-[var(--color-ink)] [&_strong]:font-medium [&_strong]:text-[var(--color-ink)]">
      {children}
    </p>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-6 border-l-2 border-[var(--color-border-strong)] pl-5 font-italic-serif text-[20px] italic leading-[1.55] text-[var(--color-ink-2)]">
      {children}
    </blockquote>
  ),
  ul: ({ children }) => (
    <ul className="mb-5 ml-5 list-disc space-y-1.5 text-[16px] leading-[1.7] text-[var(--color-ink)] marker:text-[var(--color-ink-3)]">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-5 ml-5 list-decimal space-y-1.5 text-[16px] leading-[1.7] text-[var(--color-ink)] marker:text-[var(--color-ink-3)]">
      {children}
    </ol>
  ),
  li: ({ children }) => <li>{children}</li>,
  a: ({ href, children }) => {
    if (isExternalUrl(href)) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--color-ink)] underline decoration-[var(--color-border-strong)] underline-offset-[3px] transition hover:decoration-[var(--color-ink)]"
        >
          {children}
          <span aria-hidden="true" className="ml-0.5 text-[var(--color-ink-3)]">
            ↗
          </span>
        </a>
      )
    }
    return (
      <a
        href={href}
        className="text-[var(--color-ink)] underline decoration-[var(--color-border-strong)] underline-offset-[3px] transition hover:decoration-[var(--color-ink)]"
      >
        {children}
      </a>
    )
  },
  code: ({ children, className }) => {
    if (!className && !flattenText(children).includes('\n')) {
      return (
        <code className="rounded bg-[var(--color-paper)] px-1.5 py-0.5 font-mono text-[13.5px] text-[var(--color-ink)]">
          {children}
        </code>
      )
    }
    return <code className={className}>{children}</code>
  },
  pre: ({ children }) => {
    const text = flattenText(children).trimEnd()
    if (/[├└│]/.test(text)) {
      return <TreeBlock text={text} />
    }
    return (
      <div className="group relative my-6">
        <pre className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-paper)] px-5 py-4 font-mono text-[13.5px] leading-[1.55] text-[var(--color-ink)]">
          {children}
        </pre>
        <CopyButton text={text} />
      </div>
    )
  },
  hr: () => <hr className="my-10 border-[var(--color-border)]" />,
  strong: ({ children }) => (
    <strong className="font-medium text-[var(--color-ink)]">{children}</strong>
  ),
  em: ({ children }) => (
    <em className="font-italic-serif italic text-[var(--color-ink)]">{children}</em>
  ),
  table: ({ children }) => (
    <div className="my-6 overflow-x-auto">
      <table className="w-full border-collapse text-left text-[14.5px] leading-[1.55]">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b border-[var(--color-border-strong)] text-[var(--color-ink)]">
      {children}
    </thead>
  ),
  tbody: ({ children }) => <tbody>{Children.toArray(children)}</tbody>,
  tr: ({ children }) => (
    <tr className="border-b border-[var(--color-border)] last:border-b-0">{children}</tr>
  ),
  th: ({ children }) => (
    <th className="px-3 py-2.5 font-medium text-[var(--color-ink)] [&_code]:bg-transparent [&_code]:px-0">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-3 py-2.5 align-top text-[var(--color-ink-2)] [&_code]:text-[13px]">
      {children}
    </td>
  ),
}

export function DocsContent({ content }: { content: string }) {
  return (
    <article className="docs-content">
      <ReactMarkdown
        remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
        rehypePlugins={[rehypeSanitize]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </article>
  )
}
