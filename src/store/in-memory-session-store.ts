import type { SessionStore, StoredRun } from '@noetaris/harness'
import { randomUUID } from 'node:crypto'
import { BranchNotFoundError, ConcurrentModificationError } from '../errors.js'

/**
 * In-process {@link SessionStore} backed by plain `Map` instances.
 *
 * Suitable for development, testing, and single-process deployments.
 * State is lost when the process exits — use {@link LocalFileSessionStore}
 * or a database-backed store for durable persistence.
 *
 * Supports the full optional API: `loadHistory` and `branch`.
 *
 * @example
 * ```ts
 * const h = createHarness<Ctx>()().store({ session: new InMemorySessionStore() })
 * ```
 */
export class InMemorySessionStore implements SessionStore {
  private readonly latest = new Map<string, StoredRun>()
  private readonly history = new Map<string, StoredRun[]>()

  constructor() { /* no-op */ }

  private key(agentId: string, sessionId: string): string {
    return `${agentId}\0${sessionId}`
  }

  async load(agentId: string, sessionId: string): Promise<StoredRun | null> {
    return this.latest.get(this.key(agentId, sessionId)) ?? null
  }

  async save(agentId: string, sessionId: string, run: StoredRun): Promise<void> {
    const k = this.key(agentId, sessionId)
    const current = this.latest.get(k)
    const expectedVersion = current !== undefined ? current.version + 1 : 0
    if (run.version !== expectedVersion) {
      throw new ConcurrentModificationError(
        sessionId,
        run.version,
        current?.version ?? -1,
      )
    }
    this.latest.set(k, run)
    const runs = this.history.get(k) ?? []
    runs.push(run)
    this.history.set(k, runs)
  }

  async loadHistory(agentId: string, sessionId: string): Promise<StoredRun[]> {
    return [...(this.history.get(this.key(agentId, sessionId)) ?? [])]
  }

  async branch(agentId: string, sessionId: string, runId: string): Promise<string> {
    const runs = this.history.get(this.key(agentId, sessionId)) ?? []
    const source = runs.find(entry => entry.runId === runId)

    if (source === undefined) {
      throw new BranchNotFoundError(sessionId, runId)
    }

    const newSessionId = randomUUID()
    const now = new Date().toISOString()

    const synthetic: StoredRun = {
      agentId,
      runId: randomUUID(),
      sessionId: newSessionId,
      version: 0,
      startedAt: now,
      settledAt: now,
      phase: 'completed',
      initialState: source.finalState,
      finalState: source.finalState,
    }

    await this.save(agentId, newSessionId, synthetic)
    return newSessionId
  }
}
