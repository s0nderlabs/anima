import { describe, expect, it } from 'bun:test'
import {
  COMMAND_REGISTRY,
  commandsForSurface,
  findCommand,
  parseSlash,
  suggestForPrefix,
} from './registry'

describe('COMMAND_REGISTRY', () => {
  it('has no duplicate names', () => {
    const names = COMMAND_REGISTRY.map(c => c.name)
    const set = new Set(names)
    expect(set.size).toBe(names.length)
  })

  it('every entry has at least one surface', () => {
    for (const c of COMMAND_REGISTRY) {
      expect(c.surfaces.length).toBeGreaterThan(0)
    }
  })

  it('every entry has a non-empty description', () => {
    for (const c of COMMAND_REGISTRY) {
      expect(c.description.length).toBeGreaterThan(0)
    }
  })

  it('all names are lowercase, no leading slash', () => {
    for (const c of COMMAND_REGISTRY) {
      expect(c.name).toBe(c.name.toLowerCase())
      expect(c.name.startsWith('/')).toBe(false)
    }
  })

  it('contains the cross-surface bypass commands required for v0.20.0', () => {
    expect(findCommand('yolo')).toBeDefined()
    expect(findCommand('perms')).toBeDefined()
    expect(findCommand('reset')).toBeDefined()
    expect(findCommand('yolo')?.surfaces).toEqual(['tui', 'tg'])
    expect(findCommand('perms')?.surfaces).toEqual(['tui', 'tg'])
    expect(findCommand('reset')?.surfaces).toEqual(['tui', 'tg'])
  })
})

describe('commandsForSurface', () => {
  it('returns only TUI commands when surface=tui', () => {
    const tui = commandsForSurface('tui')
    expect(tui.length).toBeGreaterThan(0)
    for (const c of tui) expect(c.surfaces).toContain('tui')
  })

  it('returns only TG commands when surface=tg', () => {
    const tg = commandsForSurface('tg')
    expect(tg.length).toBeGreaterThan(0)
    for (const c of tg) expect(c.surfaces).toContain('tg')
  })

  it('cross-surface commands appear in both lists', () => {
    const tui = commandsForSurface('tui').map(c => c.name)
    const tg = commandsForSurface('tg').map(c => c.name)
    expect(tui).toContain('yolo')
    expect(tg).toContain('yolo')
    expect(tui).toContain('perms')
    expect(tg).toContain('perms')
    expect(tui).toContain('reset')
    expect(tg).toContain('reset')
  })

  it('TUI-only commands do not appear in TG', () => {
    const tg = commandsForSurface('tg').map(c => c.name)
    expect(tg).not.toContain('sync')
    expect(tg).not.toContain('model')
    expect(tg).not.toContain('jobs')
    expect(tg).not.toContain('help')
  })

  it('TG-only commands do not appear in TUI', () => {
    const tui = commandsForSurface('tui').map(c => c.name)
    expect(tui).not.toContain('stop')
    expect(tui).not.toContain('new')
    expect(tui).not.toContain('status')
    expect(tui).not.toContain('approve')
  })
})

describe('findCommand', () => {
  it('resolves bare names', () => {
    expect(findCommand('yolo')?.name).toBe('yolo')
  })

  it('strips leading slashes', () => {
    expect(findCommand('/yolo')?.name).toBe('yolo')
    expect(findCommand('//yolo')?.name).toBe('yolo')
  })

  it('is case-insensitive', () => {
    expect(findCommand('YOLO')?.name).toBe('yolo')
    expect(findCommand('Yolo')?.name).toBe('yolo')
  })

  it('returns undefined for unknown names', () => {
    expect(findCommand('definitely-not-a-command')).toBeUndefined()
  })
})

describe('parseSlash', () => {
  it('returns null for non-slash input', () => {
    expect(parseSlash('hello')).toBeNull()
    expect(parseSlash('  hi /yolo')).toBeNull()
  })

  it('returns null for empty slash', () => {
    expect(parseSlash('/')).toBeNull()
    expect(parseSlash('   /   ')).toBeNull()
  })

  it('parses bare command name', () => {
    const r = parseSlash('/yolo')
    expect(r?.name).toBe('yolo')
    expect(r?.args).toEqual([])
    expect(r?.command?.name).toBe('yolo')
  })

  it('parses command with args', () => {
    const r = parseSlash('/perms strict')
    expect(r?.name).toBe('perms')
    expect(r?.args).toEqual(['strict'])
    expect(r?.command?.name).toBe('perms')
  })

  it('lowercases the command name', () => {
    const r = parseSlash('/YOLO')
    expect(r?.name).toBe('yolo')
  })

  it('preserves arg case', () => {
    const r = parseSlash('/perms STRICT')
    expect(r?.args).toEqual(['STRICT'])
  })

  it('returns parsed shape with undefined command for unknown names', () => {
    const r = parseSlash('/wat is this')
    expect(r?.name).toBe('wat')
    expect(r?.args).toEqual(['is', 'this'])
    expect(r?.command).toBeUndefined()
  })

  it('tolerates leading whitespace', () => {
    const r = parseSlash('   /yolo on')
    expect(r?.name).toBe('yolo')
    expect(r?.args).toEqual(['on'])
  })
})

describe('suggestForPrefix', () => {
  it('returns all surface commands for empty query', () => {
    const all = commandsForSurface('tui')
    expect(suggestForPrefix('tui', '')).toEqual(all)
    expect(suggestForPrefix('tui', '/')).toEqual(all)
  })

  it('filters by prefix', () => {
    const out = suggestForPrefix('tui', 'y')
    const names = out.map(c => c.name)
    expect(names).toContain('yolo')
    expect(names).not.toContain('perms')
  })

  it('strips leading slash from query', () => {
    expect(suggestForPrefix('tui', '/y').map(c => c.name)).toContain('yolo')
  })

  it('is case-insensitive on query', () => {
    expect(suggestForPrefix('tui', 'YO').map(c => c.name)).toContain('yolo')
  })

  it('returns empty when nothing matches', () => {
    expect(suggestForPrefix('tui', 'xyz-no-match')).toEqual([])
  })

  it('respects surface filter', () => {
    const tg = suggestForPrefix('tg', 'sy').map(c => c.name)
    expect(tg).not.toContain('sync')
  })
})
