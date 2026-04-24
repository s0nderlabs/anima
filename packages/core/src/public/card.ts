import matter from 'gray-matter'

export interface CardFrontmatter {
  /** Display name, e.g. "Alice". */
  name: string
  /** Short one-line bio, <= 140 chars. */
  bio?: string
  /** Skills / domains the agent is competent in. */
  skills?: string[]
  /** Endpoints the agent exposes (URLs). */
  endpoints?: string[]
  /** Avatar: either a 0G Storage CID or an absolute URL. */
  avatar?: string
  /** Fully-qualified .0g subname, e.g. "alice.anima.0g". */
  subname?: string
  /** iNFT pointer, CAIP-10-ish: eip155:<chainId>:<contract>:<tokenId> */
  inft?: string
  [key: string]: unknown
}

export interface Card {
  frontmatter: CardFrontmatter
  body: string
}

const DEFAULT_CARD: Card = {
  frontmatter: {
    name: '',
    bio: '',
    skills: [],
    endpoints: [],
  },
  body: '',
}

export function parseCard(markdown: string): Card {
  const parsed = matter(markdown)
  const fm = (parsed.data ?? {}) as CardFrontmatter
  if (typeof fm.name !== 'string') {
    throw new Error('CARD.md requires a "name" frontmatter field')
  }
  return { frontmatter: fm, body: parsed.content ?? '' }
}

export function renderCard(card: Card): string {
  return matter.stringify(card.body, card.frontmatter as Record<string, unknown>)
}

export function emptyCard(): Card {
  return {
    frontmatter: { ...DEFAULT_CARD.frontmatter },
    body: DEFAULT_CARD.body,
  }
}

/** Map a Card to the text-record key/value pairs we publish to .0g. */
export function cardToTextRecords(card: Card, agentEoa?: string): Record<string, string> {
  const rec: Record<string, string> = {}
  const fm = card.frontmatter
  if (agentEoa) rec.address = agentEoa
  if (fm.bio) rec['agent:bio'] = fm.bio
  if (fm.skills?.length) rec['agent:skills'] = fm.skills.join(',')
  if (fm.endpoints?.length) rec['agent:endpoints'] = fm.endpoints.join(',')
  if (fm.avatar) rec.avatar = fm.avatar
  if (fm.inft) rec['agent:inft'] = fm.inft
  return rec
}
