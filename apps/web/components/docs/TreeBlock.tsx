import { CopyButton } from './CopyButton'

type CellKind = 'vertical' | 'space' | 'branch' | 'lastBranch'

interface TreeRow {
  ancestors: ('vertical' | 'space')[]
  own: 'branch' | 'lastBranch' | 'none'
  label: string
}

const LEVEL = '    '
const VERTICAL = '│   '
const BRANCH = '├── '
const LAST_BRANCH = '└── '

function parseTree(text: string): TreeRow[] {
  const out: TreeRow[] = []
  for (const raw of text.split('\n')) {
    if (raw === '') continue
    const ancestors: ('vertical' | 'space')[] = []
    let line = raw
    while (line.startsWith(VERTICAL) || line.startsWith(LEVEL)) {
      if (line.startsWith(VERTICAL)) {
        ancestors.push('vertical')
        line = line.slice(VERTICAL.length)
      } else {
        ancestors.push('space')
        line = line.slice(LEVEL.length)
      }
    }
    if (line.startsWith(BRANCH)) {
      out.push({ ancestors, own: 'branch', label: line.slice(BRANCH.length) })
    } else if (line.startsWith(LAST_BRANCH)) {
      out.push({ ancestors, own: 'lastBranch', label: line.slice(LAST_BRANCH.length) })
    } else {
      out.push({ ancestors, own: 'none', label: line })
    }
  }
  return out
}

function Cell({ kind }: { kind: CellKind }) {
  const base = 'relative inline-block self-stretch'
  const width = 'w-[2.6ch]'
  if (kind === 'space') {
    return <span aria-hidden="true" className={`${base} ${width}`} />
  }
  if (kind === 'vertical') {
    return (
      <span aria-hidden="true" className={`${base} ${width}`}>
        <span className="absolute inset-y-0 left-[0.6ch] w-px bg-[var(--color-ink-2)]" />
      </span>
    )
  }
  return (
    <span aria-hidden="true" className={`${base} ${width}`}>
      <span
        className={`absolute left-[0.6ch] w-px bg-[var(--color-ink-2)] ${
          kind === 'branch' ? 'inset-y-0' : 'top-0 h-1/2'
        }`}
      />
      <span className="absolute left-[0.6ch] top-1/2 right-0 h-px bg-[var(--color-ink-2)]" />
    </span>
  )
}

export function TreeBlock({ text }: { text: string }) {
  const rows = parseTree(text)
  return (
    <div className="group relative my-6">
      <div
        className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-paper)] px-5 py-4 font-mono text-[13.5px] leading-[1.7] text-[var(--color-ink)]"
        role="figure"
        aria-label="directory tree"
      >
        {rows.map((row, i) => (
          <div key={i} className="flex items-stretch whitespace-nowrap">
            {row.ancestors.map((kind, j) => (
              <Cell key={j} kind={kind} />
            ))}
            {row.own !== 'none' && (
              <Cell kind={row.own === 'lastBranch' ? 'lastBranch' : 'branch'} />
            )}
            <span className="self-center">{row.label}</span>
          </div>
        ))}
      </div>
      <CopyButton text={text} />
    </div>
  )
}
