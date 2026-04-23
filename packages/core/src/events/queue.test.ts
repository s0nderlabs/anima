import { expect, test } from 'bun:test'
import { EventQueue, newEventId } from './queue'

test('FIFO ordering', async () => {
  const q = new EventQueue()
  for (let i = 0; i < 3; i++) {
    q.enqueue({
      id: newEventId(),
      source: 'stdin',
      payload: { label: `e${i}`, data: i },
      ts: Date.now(),
    })
  }
  const a = await q.dequeue()
  const b = await q.dequeue()
  const c = await q.dequeue()
  expect(a.payload.label).toBe('e0')
  expect(b.payload.label).toBe('e1')
  expect(c.payload.label).toBe('e2')
})

test('dequeue awaits when empty', async () => {
  const q = new EventQueue()
  const pending = q.dequeue()
  setTimeout(() => {
    q.enqueue({
      id: 'late',
      source: 'stdin',
      payload: { label: 'late', data: null },
      ts: Date.now(),
    })
  }, 10)
  const ev = await pending
  expect(ev.payload.label).toBe('late')
})

test('closed queue throws on enqueue', () => {
  const q = new EventQueue()
  q.close()
  expect(() =>
    q.enqueue({ id: 'x', source: 'stdin', payload: { label: 'x', data: null }, ts: 0 }),
  ).toThrow()
})
