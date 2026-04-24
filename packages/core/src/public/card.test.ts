import { describe, expect, test } from 'bun:test'
import { cardToTextRecords, emptyCard, parseCard, renderCard } from './card'

describe('card', () => {
  test('parses frontmatter + body', () => {
    const md = `---
name: Alice
bio: research anima
skills:
  - research
  - writing
---

Free-form body here.`
    const c = parseCard(md)
    expect(c.frontmatter.name).toBe('Alice')
    expect(c.frontmatter.bio).toBe('research anima')
    expect(c.frontmatter.skills).toEqual(['research', 'writing'])
    expect(c.body.trim()).toBe('Free-form body here.')
  })

  test('rejects missing name', () => {
    expect(() => parseCard('---\nbio: no name\n---\nbody')).toThrow()
  })

  test('round-trips via render', () => {
    const c = {
      frontmatter: { name: 'Bob', bio: 'hi', skills: ['code'] },
      body: 'Body.',
    }
    const rendered = renderCard(c)
    const parsed = parseCard(rendered)
    expect(parsed.frontmatter.name).toBe('Bob')
    expect(parsed.frontmatter.skills).toEqual(['code'])
  })

  test('emptyCard is parseable after setting a name', () => {
    const c = emptyCard()
    c.frontmatter.name = 'Temp'
    const rendered = renderCard(c)
    const parsed = parseCard(rendered)
    expect(parsed.frontmatter.name).toBe('Temp')
  })

  test('cardToTextRecords includes address + agent:inft when present', () => {
    const c = {
      frontmatter: {
        name: 'Alice',
        bio: 'hi',
        skills: ['research', 'writing'],
        inft: 'eip155:16602:0xabc:42',
        avatar: '0xdeadbeef',
      },
      body: '',
    }
    const r = cardToTextRecords(c, '0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec')
    expect(r.address).toBe('0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec')
    expect(r['agent:bio']).toBe('hi')
    expect(r['agent:skills']).toBe('research,writing')
    expect(r['agent:inft']).toBe('eip155:16602:0xabc:42')
    expect(r.avatar).toBe('0xdeadbeef')
  })

  test('cardToTextRecords omits empty fields', () => {
    const c = emptyCard()
    c.frontmatter.name = 'NoExtras'
    const r = cardToTextRecords(c)
    expect(Object.keys(r)).toHaveLength(0)
  })
})
