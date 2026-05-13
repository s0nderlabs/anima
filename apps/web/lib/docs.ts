import { promises as fs } from 'node:fs'
import path from 'node:path'

const DOCS_DIR = path.join(process.cwd(), 'content', 'docs')

export interface DocFrontmatter {
  slug: string
  title: string
  description: string
  group: string
  order: number
  kicker: string
  voiceWord?: string
  source?: string
}

export interface Doc {
  frontmatter: DocFrontmatter
  content: string
}

export interface NavItem {
  slug: string
  title: string
  description: string
}

export interface NavGroup {
  name: string
  items: NavItem[]
}

function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  if (!raw.startsWith('---\n')) {
    return { data: {}, body: raw }
  }
  const close = raw.indexOf('\n---\n', 4)
  if (close === -1) {
    return { data: {}, body: raw }
  }
  const yaml = raw.slice(4, close)
  const body = raw.slice(close + 5)
  const data: Record<string, unknown> = {}
  for (const line of yaml.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const colon = trimmed.indexOf(':')
    if (colon === -1) continue
    const key = trimmed.slice(0, colon).trim()
    let value = trimmed.slice(colon + 1).trim()
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1)
    }
    if (/^-?\d+(?:\.\d+)?$/.test(value)) {
      data[key] = Number(value)
    } else if (value === 'true' || value === 'false') {
      data[key] = value === 'true'
    } else {
      data[key] = value
    }
  }
  return { data, body }
}

function toFrontmatter(slug: string, data: Record<string, unknown>): DocFrontmatter {
  return {
    slug: typeof data.slug === 'string' ? data.slug : slug,
    title: typeof data.title === 'string' ? data.title : slug,
    description: typeof data.description === 'string' ? data.description : '',
    group: typeof data.group === 'string' ? data.group : 'General',
    order: typeof data.order === 'number' ? data.order : 999,
    kicker: typeof data.kicker === 'string' ? data.kicker : 'DOCS',
    voiceWord: typeof data.voice_word === 'string' ? data.voice_word : undefined,
    source: typeof data.source === 'string' ? data.source : undefined,
  }
}

async function readDocFile(filename: string): Promise<Doc> {
  const raw = await fs.readFile(path.join(DOCS_DIR, filename), 'utf8')
  const { data, body } = parseFrontmatter(raw)
  const slugFromName = filename.replace(/^\d+-/, '').replace(/\.md$/, '')
  return {
    frontmatter: toFrontmatter(slugFromName, data),
    content: body.replace(/^\n+/, ''),
  }
}

let _cache: Promise<Doc[]> | null = null

export async function listDocs(): Promise<Doc[]> {
  if (!_cache) {
    _cache = (async () => {
      const files = await fs.readdir(DOCS_DIR)
      const md = files.filter(f => f.endsWith('.md')).sort()
      const docs = await Promise.all(md.map(readDocFile))
      return docs.sort((a, b) => a.frontmatter.order - b.frontmatter.order)
    })()
  }
  return _cache
}

export async function getDoc(slug: string): Promise<Doc | null> {
  const docs = await listDocs()
  return docs.find(d => d.frontmatter.slug === slug) ?? null
}

export async function getNavTree(): Promise<NavGroup[]> {
  const docs = await listDocs()
  const groupOrder: string[] = []
  const groups = new Map<string, NavItem[]>()
  for (const doc of docs) {
    const { group, slug, title, description } = doc.frontmatter
    if (!groups.has(group)) {
      groupOrder.push(group)
      groups.set(group, [])
    }
    groups.get(group)?.push({ slug, title, description })
  }
  return groupOrder.map(name => ({ name, items: groups.get(name) ?? [] }))
}

export interface AdjacentDocs {
  prev: { slug: string; title: string } | null
  next: { slug: string; title: string } | null
}

export async function getAdjacent(slug: string): Promise<AdjacentDocs> {
  const docs = await listDocs()
  const i = docs.findIndex(d => d.frontmatter.slug === slug)
  if (i === -1) return { prev: null, next: null }
  const prev = i > 0 ? docs[i - 1].frontmatter : null
  const next = i < docs.length - 1 ? docs[i + 1].frontmatter : null
  return {
    prev: prev ? { slug: prev.slug, title: prev.title } : null,
    next: next ? { slug: next.slug, title: next.title } : null,
  }
}

export async function listSlugs(): Promise<string[]> {
  const docs = await listDocs()
  return docs.map(d => d.frontmatter.slug)
}
