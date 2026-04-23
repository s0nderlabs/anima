import type { EventQueue } from './queue'

/**
 * A Listener watches some source (stdin, chain, a2a, ...) and pushes events
 * onto the queue. Plugins contribute listeners via `registerListener()`.
 */
export interface Listener {
  name: string
  source: string
  start(queue: EventQueue): Promise<void>
  stop(): Promise<void>
}

class ListenerRegistry {
  private registered: Listener[] = []

  register(l: Listener): void {
    if (this.registered.some(x => x.name === l.name)) {
      throw new Error(`Listener already registered: ${l.name}`)
    }
    this.registered.push(l)
  }

  list(): readonly Listener[] {
    return this.registered
  }

  async startAll(queue: EventQueue): Promise<void> {
    await Promise.all(this.registered.map(l => l.start(queue)))
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.registered.map(l => l.stop()))
  }
}

export const listeners = new ListenerRegistry()
