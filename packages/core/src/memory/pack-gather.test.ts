import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodePackBlob, encodePackBlob } from './pack-blob'
import { gatherAgentPack, gatherUserPack, writeAgentPack, writeUserPack } from './pack-gather'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pack-gather-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

async function seed(rel: string, content: string): Promise<void> {
  const full = join(tmp, rel)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content)
}

test('gatherAgentPack returns root + non-excluded files', async () => {
  await seed('MEMORY.md', '# memory index')
  await seed('agent/identity.md', 'identity body')
  await seed('agent/persona.md', 'persona body')
  await seed('agent/learned-foo.md', 'foo content')
  await seed('agent/learned-bar.md', 'bar content')

  const res = await gatherAgentPack(tmp)
  expect(res.root).toBe('# memory index')
  expect(res.files['learned-foo.md']).toBe('foo content')
  expect(res.files['learned-bar.md']).toBe('bar content')
  // Identity + persona excluded — they have their own slots
  expect(res.files['identity.md']).toBeUndefined()
  expect(res.files['persona.md']).toBeUndefined()
})

test('gatherUserPack returns profile.md as root + other user files', async () => {
  await seed('user/profile.md', '# user profile')
  await seed('user/operator-preferences.md', 'dark mode')
  await seed('user/0g-hackathon.md', 'deadline')
  const res = await gatherUserPack(tmp)
  expect(res.root).toBe('# user profile')
  expect(res.files['operator-preferences.md']).toBe('dark mode')
  expect(res.files['0g-hackathon.md']).toBe('deadline')
  // profile.md is the root, not in files
  expect(res.files['profile.md']).toBeUndefined()
})

test('gather handles missing partition dir', async () => {
  await seed('MEMORY.md', 'just an index')
  const res = await gatherAgentPack(tmp)
  expect(res.root).toBe('just an index')
  expect(res.files).toEqual({})
})

test('gather handles missing root file', async () => {
  await seed('agent/learned-x.md', 'content')
  const res = await gatherAgentPack(tmp)
  expect(res.root).toBe('')
  expect(res.files['learned-x.md']).toBe('content')
})

test('gather skips non-md files + empty .md', async () => {
  await seed('agent/learned-x.md', 'content')
  await seed('agent/junk.txt', 'not md')
  await seed('agent/empty.md', '')
  const res = await gatherAgentPack(tmp)
  expect(res.files['learned-x.md']).toBe('content')
  expect(res.files['junk.txt']).toBeUndefined()
  expect(res.files['empty.md']).toBeUndefined()
})

test('writeAgentPack reverses gatherAgentPack', async () => {
  await seed('MEMORY.md', 'index v1')
  await seed('agent/learned-a.md', 'a')
  await seed('agent/learned-b.md', 'b')
  const gathered = await gatherAgentPack(tmp)
  const bytes = encodePackBlob(gathered)
  const decoded = decodePackBlob(bytes)

  const dst = mkdtempSync(join(tmpdir(), 'pack-write-'))
  try {
    await writeAgentPack(dst, decoded)
    expect(await readFile(join(dst, 'MEMORY.md'), 'utf8')).toBe('index v1')
    expect(await readFile(join(dst, 'agent', 'learned-a.md'), 'utf8')).toBe('a')
    expect(await readFile(join(dst, 'agent', 'learned-b.md'), 'utf8')).toBe('b')
  } finally {
    rmSync(dst, { recursive: true, force: true })
  }
})

test('writeUserPack creates user dir + profile + sibling files', async () => {
  const dst = mkdtempSync(join(tmpdir(), 'pack-write-'))
  try {
    await writeUserPack(dst, {
      v: 2,
      root: '# profile',
      files: { 'operator-preferences.md': 'prefs', 'hack-2026.md': 'deadline' },
    })
    expect(await readFile(join(dst, 'user', 'profile.md'), 'utf8')).toBe('# profile')
    expect(await readFile(join(dst, 'user', 'operator-preferences.md'), 'utf8')).toBe('prefs')
    expect(await readFile(join(dst, 'user', 'hack-2026.md'), 'utf8')).toBe('deadline')
  } finally {
    rmSync(dst, { recursive: true, force: true })
  }
})
