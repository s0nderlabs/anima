import { expect, test } from 'bun:test'
import { EditError, applyEdit } from './edit'

test('add on empty body inserts content', () => {
  const out = applyEdit('', { action: 'add', newText: 'hello' })
  expect(out).toBe('hello')
})

test('add appends with double newline on existing body', () => {
  const out = applyEdit('first line', { action: 'add', newText: 'second line' })
  expect(out).toBe('first line\n\nsecond line\n')
})

test('replace substring', () => {
  const out = applyEdit('foo bar baz', {
    action: 'replace',
    oldText: 'bar',
    newText: 'qux',
  })
  expect(out).toBe('foo qux baz')
})

test('replace throws when oldText missing', () => {
  expect(() =>
    applyEdit('foo bar', { action: 'replace', oldText: 'missing', newText: 'x' }),
  ).toThrow(EditError)
})

test('replace throws when oldText is ambiguous', () => {
  expect(() => applyEdit('foo foo', { action: 'replace', oldText: 'foo', newText: 'x' })).toThrow(
    EditError,
  )
})

test('remove strips matching substring', () => {
  const out = applyEdit('leading payload trailing', {
    action: 'remove',
    oldText: 'payload ',
  })
  expect(out).toBe('leading trailing')
})
