import { expect, test } from 'bun:test'
import { parseTopic, stringifyTopic } from './parser'

const SAMPLE = `---
name: user feedback
description: elpabl0 prefers terse replies
type: feedback
---
User confirmed no wall-of-text responses in conversations.
`

test('parseTopic reads frontmatter + body', () => {
  const topic = parseTopic('user', 'feedback-terse', SAMPLE)
  expect(topic.frontmatter.name).toBe('user feedback')
  expect(topic.frontmatter.type).toBe('feedback')
  expect(topic.body.startsWith('User confirmed')).toBe(true)
})

test('stringifyTopic round-trips', () => {
  const topic = parseTopic('user', 'feedback-terse', SAMPLE)
  const out = stringifyTopic(topic)
  const reparsed = parseTopic('user', 'feedback-terse', out)
  expect(reparsed.frontmatter.name).toBe(topic.frontmatter.name)
  expect(reparsed.body.trim()).toBe(topic.body.trim())
})

test('parseTopic throws on missing frontmatter', () => {
  expect(() => parseTopic('user', 'broken', '# no frontmatter\ntext')).toThrow()
})
