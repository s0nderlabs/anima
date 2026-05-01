import { describe, expect, test } from 'bun:test'
import { EventHub, type HarnessEvent } from './events'

describe('EventHub', () => {
  test('publishes events in seq order with monotonic ids', () => {
    const hub = new EventHub()
    const a = hub.publish('log', { msg: 'a' })
    const b = hub.publish('log', { msg: 'b' })
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect(b.ts).toBeGreaterThanOrEqual(a.ts)
    expect(hub.lastSeq()).toBe(2)
  })

  test('subscribers receive future events', () => {
    const hub = new EventHub()
    const got: HarnessEvent[] = []
    const unsub = hub.subscribe(e => got.push(e))
    hub.publish('log', { msg: 'a' })
    hub.publish('log', { msg: 'b' })
    expect(got.length).toBe(2)
    unsub()
    hub.publish('log', { msg: 'c' })
    expect(got.length).toBe(2)
  })

  test('sinceSeq replays buffered events', () => {
    const hub = new EventHub()
    hub.publish('log', { msg: 'a' })
    const b = hub.publish('log', { msg: 'b' })
    hub.publish('log', { msg: 'c' })
    const got: HarnessEvent[] = []
    hub.subscribe(e => got.push(e), b.seq)
    expect(got.map(e => e.seq)).toEqual([3])
  })

  test('buffer respects bufferLimit', () => {
    const hub = new EventHub({ bufferLimit: 3 })
    for (let i = 0; i < 10; i++) hub.publish('log', { i })
    const buf = hub.buffer()
    expect(buf.length).toBe(3)
    expect(buf[0]?.seq).toBe(8)
  })

  test('one slow subscriber does not block the bus', () => {
    const hub = new EventHub()
    const got: HarnessEvent[] = []
    hub.subscribe(() => {
      throw new Error('boom')
    })
    hub.subscribe(e => got.push(e))
    hub.publish('log', { msg: 'a' })
    expect(got.length).toBe(1)
  })
})
