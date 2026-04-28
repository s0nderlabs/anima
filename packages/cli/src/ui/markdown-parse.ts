/**
 * Lightweight markdown parser for the assistant chat rows. Pure logic only,
 * no JSX, so tests can import without dragging in the JSX runtime (CI's bun
 * defaults to react-jsx and fails to resolve `react/jsx-dev-runtime` when
 * a .tsx file is imported by a test).
 *
 * Subset the brain actually emits: `**bold**`, `*italic*`, `` `code` ``,
 * `# headings`, `- bullet lists`, `1. numbered lists`, fenced code blocks.
 */

export interface MdSegment {
  text: string
  fg?: string
  bold?: boolean
  italic?: boolean
}

export const MD_COLORS = {
  text: '#e5e7eb',
  code: '#fda4af',
  heading: '#fbbf24',
  bullet: '#94a3b8',
  codeBlock: '#f9a8d4',
}

/**
 * Parse a single line's inline markup (`**bold**`, `*italic*`, `` `code` ``)
 * into a flat list of segments. Caller handles the line-level structure.
 */
function parseInline(line: string, baseFg: string = MD_COLORS.text): MdSegment[] {
  const out: MdSegment[] = []
  let i = 0
  let plain = ''
  const flushPlain = () => {
    if (plain) {
      out.push({ text: plain, fg: baseFg })
      plain = ''
    }
  }
  while (i < line.length) {
    if (line[i] === '`') {
      const end = line.indexOf('`', i + 1)
      if (end > i) {
        flushPlain()
        out.push({ text: line.slice(i + 1, end), fg: MD_COLORS.code })
        i = end + 1
        continue
      }
    }
    if (line[i] === '*' && line[i + 1] === '*') {
      const end = line.indexOf('**', i + 2)
      if (end > i + 2) {
        flushPlain()
        out.push({ text: line.slice(i + 2, end), fg: baseFg, bold: true })
        i = end + 2
        continue
      }
    }
    if (line[i] === '*' && line[i + 1] !== '*' && line[i + 1] !== ' ') {
      const end = line.indexOf('*', i + 1)
      if (end > i + 1 && line[end - 1] !== ' ' && line[end + 1] !== '*') {
        flushPlain()
        out.push({ text: line.slice(i + 1, end), fg: baseFg, italic: true })
        i = end + 1
        continue
      }
    }
    plain += line[i]
    i++
  }
  flushPlain()
  return out
}

/**
 * Parse the full text into a flat list of segments separated by newlines.
 * Block-level structure is encoded as styled prefixes in the segments
 * (heading -> bold colored line; bullet -> "• " + content).
 */
export function parseMarkdown(text: string): MdSegment[] {
  if (!text) return []
  const out: MdSegment[] = []
  const lines = text.split('\n')
  let inFence = false
  let firstLine = true

  const pushNewline = () => {
    if (!firstLine) out.push({ text: '\n', fg: MD_COLORS.text })
    firstLine = false
  }

  for (const rawLine of lines) {
    if (rawLine.trim().startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      pushNewline()
      out.push({ text: rawLine, fg: MD_COLORS.codeBlock })
      continue
    }
    const headingMatch = rawLine.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      pushNewline()
      const inner = parseInline(headingMatch[2]!, MD_COLORS.heading)
      for (const seg of inner) {
        out.push({ ...seg, fg: seg.fg ?? MD_COLORS.heading, bold: true })
      }
      continue
    }
    const bulletMatch = rawLine.match(/^(\s*)([-*])\s+(.*)$/)
    if (bulletMatch) {
      pushNewline()
      out.push({ text: `${bulletMatch[1]}• `, fg: MD_COLORS.bullet })
      out.push(...parseInline(bulletMatch[3]!))
      continue
    }
    const numberedMatch = rawLine.match(/^(\s*)(\d+)\.\s+(.*)$/)
    if (numberedMatch) {
      pushNewline()
      out.push({
        text: `${numberedMatch[1]}${numberedMatch[2]}. `,
        fg: MD_COLORS.bullet,
      })
      out.push(...parseInline(numberedMatch[3]!))
      continue
    }
    pushNewline()
    out.push(...parseInline(rawLine))
  }
  return out
}
