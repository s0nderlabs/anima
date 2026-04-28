import { For } from 'solid-js'

/**
 * Lightweight markdown renderer for the assistant chat rows. Parses the
 * subset the brain actually emits (`**bold**`, `*italic*`, `` `code` ``,
 * `# headings`, `- lists`, fenced code blocks) and emits opentui spans
 * with appropriate fg + bold/italic attributes. Anything not matched is
 * passed through verbatim.
 *
 * Why custom rather than opentui's built-in `<markdown>`: anima already
 * renders assistant text inside a row that has a fixed-width prefix
 * gutter; switching to `<markdown>` would break the indent and gutter
 * alignment because it owns its own layout. A custom renderer that emits
 * spans keeps the existing AssistantTextRow flow intact.
 */

export interface MdSegment {
  text: string
  fg?: string
  bold?: boolean
  italic?: boolean
}

const COLOR_TEXT = '#e5e7eb'
const COLOR_CODE = '#fda4af'
const COLOR_HEADING = '#fbbf24'
const COLOR_BULLET = '#94a3b8'
const COLOR_CODE_BLOCK = '#f9a8d4'

/**
 * Parse a single line's inline markup (`**bold**`, `*italic*`, `` `code` ``)
 * into a flat list of segments. Caller handles the line-level structure.
 */
function parseInline(line: string, baseFg = COLOR_TEXT): MdSegment[] {
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
    // Inline code `…`
    if (line[i] === '`') {
      const end = line.indexOf('`', i + 1)
      if (end > i) {
        flushPlain()
        out.push({ text: line.slice(i + 1, end), fg: COLOR_CODE })
        i = end + 1
        continue
      }
    }
    // Bold **…** (must be checked before italic)
    if (line[i] === '*' && line[i + 1] === '*') {
      const end = line.indexOf('**', i + 2)
      if (end > i + 2) {
        flushPlain()
        out.push({ text: line.slice(i + 2, end), fg: baseFg, bold: true })
        i = end + 2
        continue
      }
    }
    // Italic *…* (single asterisk, not adjacent to space on the inside)
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
 * (e.g. heading → bold colored line; bullet → "•  " + content).
 */
export function parseMarkdown(text: string): MdSegment[] {
  if (!text) return []
  const out: MdSegment[] = []
  const lines = text.split('\n')
  let inFence = false
  let firstLine = true

  const pushNewline = () => {
    if (!firstLine) out.push({ text: '\n', fg: COLOR_TEXT })
    firstLine = false
  }

  for (const rawLine of lines) {
    // Fenced code block boundary (``` or ```lang)
    if (rawLine.trim().startsWith('```')) {
      inFence = !inFence
      // Skip the fence line itself; don't emit anything
      continue
    }
    if (inFence) {
      pushNewline()
      out.push({ text: rawLine, fg: COLOR_CODE_BLOCK })
      continue
    }
    // Heading: # / ## / ### / ####
    const headingMatch = rawLine.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      pushNewline()
      const inner = parseInline(headingMatch[2]!, COLOR_HEADING)
      for (const seg of inner) {
        out.push({ ...seg, fg: seg.fg ?? COLOR_HEADING, bold: true })
      }
      continue
    }
    // Bullet list: - / * (preserve indentation)
    const bulletMatch = rawLine.match(/^(\s*)([-*])\s+(.*)$/)
    if (bulletMatch) {
      pushNewline()
      out.push({ text: `${bulletMatch[1]}• `, fg: COLOR_BULLET })
      out.push(...parseInline(bulletMatch[3]!))
      continue
    }
    // Numbered list: 1. / 2. (preserve indentation)
    const numberedMatch = rawLine.match(/^(\s*)(\d+)\.\s+(.*)$/)
    if (numberedMatch) {
      pushNewline()
      out.push({ text: `${numberedMatch[1]}${numberedMatch[2]}. `, fg: COLOR_BULLET })
      out.push(...parseInline(numberedMatch[3]!))
      continue
    }
    // Plain line
    pushNewline()
    out.push(...parseInline(rawLine))
  }
  return out
}

/**
 * Render parsed segments as opentui spans inside an existing `<text>` block.
 * Caller owns the wrapping `<text>` (so wrapMode + flexGrow stay configurable).
 */
export function MarkdownSegments(props: { text: string }) {
  const segments = () => parseMarkdown(props.text)
  return (
    <For each={segments()}>
      {seg => {
        // opentui's SpanProps type omits fg/bold/italic but the runtime
        // accepts them. Cast through an object spread to bypass the check
        // without an @ts-expect-error (which TS reports as unused when the
        // spread itself doesn't match a property).
        const styles = {
          ...(seg.fg ? { fg: seg.fg } : {}),
          ...(seg.bold ? { bold: true } : {}),
          ...(seg.italic ? { italic: true } : {}),
        } as Record<string, unknown>
        return <span {...styles}>{seg.text}</span>
      }}
    </For>
  )
}
