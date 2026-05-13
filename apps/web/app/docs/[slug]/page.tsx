import { notFound } from 'next/navigation'
import { DocsContent } from '@/components/docs/DocsContent'
import { DocsMobileNav } from '@/components/docs/DocsMobileNav'
import { DocsPrevNext } from '@/components/docs/DocsPrevNext'
import { getAdjacent, getDoc, getNavTree, listSlugs } from '@/lib/docs'

interface PageProps {
  params: Promise<{ slug: string }>
}

export async function generateStaticParams() {
  const slugs = await listSlugs()
  return slugs.map(slug => ({ slug }))
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params
  const doc = await getDoc(slug)
  if (!doc) return { title: 'docs · anima' }
  return {
    title: `${doc.frontmatter.title} · anima docs`,
    description: doc.frontmatter.description,
  }
}

const SOURCE_BASE = 'https://github.com/s0nderlabs/anima/blob/main/'

export default async function DocPage({ params }: PageProps) {
  const { slug } = await params
  const [doc, groups, adjacent] = await Promise.all([
    getDoc(slug),
    getNavTree(),
    getAdjacent(slug),
  ])
  if (!doc) return notFound()
  const { frontmatter, content } = doc
  const activeGroup = frontmatter.group

  return (
    <article className="min-w-0">
      <DocsMobileNav
        groups={groups}
        activeSlug={slug}
        activeTitle={frontmatter.title}
        activeGroup={activeGroup}
      />

      <DocsContent content={content} />

      {frontmatter.source && (
        <p className="mt-12 font-mono text-[12px] leading-relaxed text-[var(--color-ink-3)]">
          Source:{' '}
          <a
            href={`${SOURCE_BASE}${frontmatter.source}`}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--color-ink-2)] underline decoration-[var(--color-border-strong)] underline-offset-[3px] transition hover:text-[var(--color-ink)] hover:decoration-[var(--color-ink)]"
          >
            {frontmatter.source}
          </a>
          <span aria-hidden="true" className="ml-0.5 text-[var(--color-ink-3)]">
            ↗
          </span>
        </p>
      )}

      <DocsPrevNext prev={adjacent.prev} next={adjacent.next} />
    </article>
  )
}
