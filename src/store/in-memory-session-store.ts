import type { SessionStore, StoredRun } from '@noetaris/harness'
import { randomUUID } from 'node:crypto'
import { BranchNotFoundError } from '../errors.js'

export class InMemorySessionStore implements SessionStore {
  private readonly latest = new Map<string, StoredRun>()
  private readonly history = new Map<string, StoredRun[]>()

  constructor() { /* no-op */ }

  async load(sessionId: string): Promise<StoredRun | null> {
    return this.latest.get(sessionId) ?? null
  }

  async save(sessionId: string, run: StoredRun): Promise<void> {
    this.latest.set(sessionId, run)
    const runs = this.history.get(sessionId) ?? []
    runs.push(run)
    this.history.set(sessionId, runs)
  }

  async loadHistory(sessionId: string): Promise<StoredRun[]> {
    return [...(this.history.get(sessionId) ?? [])]
  }

  async branch(sessionId: string, runId: string): Promise<string> {
    const runs = this.history.get(sessionId) ?? []
    const source = runs.find(entry => entry.runId === runId)

    if (source === undefined) {
      throw new BranchNotFoundError(sessionId, runId)
    }

    const newSessionId = randomUUID()
    const now = new Date().toISOString()

    const synthetic: StoredRun = {
      runId: randomUUID(),
      sessionId: newSessionId,
      startedAt: now,
      settledAt: now,
      phase: 'completed',
      initialState: source.finalState,
      finalState: source.finalState,
    }

    await this.save(newSessionId, synthetic)
    return newSessionId
  }
}
