import { Footer } from '@/components/Footer'
import { DocsNavbar } from '@/components/docs/DocsNavbar'
import { DocsSidebar } from '@/components/docs/DocsSidebar'
import { getNavTree } from '@/lib/docs'

export default async function DocsLayout({ children }: { children: React.ReactNode }) {
  const groups = await getNavTree()
  return (
    <main className="relative min-h-screen bg-[var(--color-cream)] text-[var(--color-ink)]">
      <DocsNavbar />
      <div className="mx-auto w-full max-w-[var(--container-wrap)] px-6 pb-24 pt-28 sm:px-8 md:pt-32">
        <div className="grid gap-10 md:grid-cols-[240px_minmax(0,1fr)] md:gap-14 lg:gap-16">
          <aside className="hidden md:block">
            <div className="md:sticky md:top-28">
              <DocsSidebar groups={groups} />
            </div>
          </aside>
          <div className="min-w-0">{children}</div>
        </div>
      </div>
      <Footer />
    </main>
  )
}
