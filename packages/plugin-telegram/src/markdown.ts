// MarkdownV2 escape + plain-text fallback.
//
// Pattern from hermes telegram.py:84. The Bot API requires every reserved
// character in MarkdownV2 entity ranges to be escaped with backslash, even
// inside code blocks for some characters. This module exposes a single
// `escapeMarkdownV2` function for the safe path and `stripMarkdownV2` for
// the plain-text fallback when parse_error fires on send.

const MARKDOWN_V2_ESCAPE_REGEX = /([_*[\]()~`>#+\-=|{}.!\\])/g

export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_ESCAPE_REGEX, '\\$1')
}

/**
 * Strip MarkdownV2 markers so a parse_error fallback can send the same content
 * as plain text. Handles the four common formatting markers (`*bold*`,
 * `_italic_`, `~strike~`, `||spoiler||`) plus drops escape backslashes.
 *
 * Code-block markers stay (TG renders them as plain text without parse_mode).
 */
export function stripMarkdownV2(text: string): string {
  let out = text
  // Drop escape backslashes that were applied by escapeMarkdownV2
  out = out.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1')
  // Strip ||spoiler|| (must run before * and _ since `||` shares chars)
  out = out.replace(/\|\|([^|]+)\|\|/g, '$1')
  // Strip *bold* (greedy-safe since markdown only allows single-line *bold*)
  out = out.replace(/\*([^*]+)\*/g, '$1')
  // Strip _italic_
  out = out.replace(/(?:^|[\s])_([^_]+)_(?=[\s]|$)/g, ' $1')
  // Strip ~strike~
  out = out.replace(/~([^~]+)~/g, '$1')
  return out
}

/**
 * Detect if a grammy / Bot API error is a MarkdownV2 parse error so callers
 * can fall back to plain-text. Hermes pattern: the error message contains
 * "can't parse entities" with the MarkdownV2 mention.
 */
export function isMarkdownParseError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  return (
    lower.includes("can't parse entities") ||
    lower.includes('cannot parse entities') ||
    (lower.includes('bad request') && (lower.includes('parse') || lower.includes('entities')))
  )
}
