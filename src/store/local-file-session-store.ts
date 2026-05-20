import type { SessionStore, StoredRun } from '@noetaris/harness'
import { appendFile, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BranchNotFoundError } from '../errors.js'

/** Options for {@link LocalFileSessionStore}. */
export interface LocalFileSessionStoreOptions {
  /**
   * Absolute or relative path to the directory where session files are stored.
   * The directory must already exist — the constructor does not create it.
   */
  readonly dir: string
}

/**
 * File-system {@link SessionStore} that persists each session as a JSONL file
 * named `<agentId>_<sessionId>.jsonl` under the configured directory.
 *
 * Each `save()` appends a new line; `load()` reads the last line; `loadHistory()`
 * reads all lines. No locking is performed — suitable for single-process use.
 *
 * Supports the full optional API: `loadHistory` and `branch`.
 *
 * @example
 * ```ts
 * const store = new LocalFileSessionStore({ dir: '/var/data/sessions' })
 * const h = createHarness<Ctx>()().store({ session: store })
 * ```
 */
export class LocalFileSessionStore implements SessionStore {
  private readonly dir: string

  constructor(options: LocalFileSessionStoreOptions) {
    this.dir = options.dir
  }

  private filePath(agentId: string, sessionId: string): string {
    return join(this.dir, `${agentId}_${sessionId}.jsonl`)
  }

  async load(agentId: string, sessionId: string): Promise<StoredRun | null> {
    try {
      const content = await readFile(this.filePath(agentId, sessionId), 'utf8')
      const lines = content.split('\n').filter(l => l.length > 0)
      const last = lines.at(-1)
      if (last === undefined) return null
      return JSON.parse(last) as StoredRun // as: JSON.parse returns unknown; JSONL file contains only StoredRun values written by save()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { // as: fs errors are ErrnoException at runtime; no narrower type available
        return null
      }
      throw err
    }
  }

  async save(agentId: string, sessionId: string, run: StoredRun): Promise<void> {
    await appendFile(this.filePath(agentId, sessionId), JSON.stringify(run) + '\n')
  }

  async loadHistory(agentId: string, sessionId: string): Promise<StoredRun[]> {
    try {
      const content = await readFile(this.filePath(agentId, sessionId), 'utf8')
      return content.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l) as StoredRun) // as: JSON.parse returns unknown; each line is a StoredRun written by save()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { // as: fs errors are ErrnoException at runtime; no narrower type available
        return []
      }
      throw err
    }
  }

  async branch(agentId: string, sessionId: string, runId: string): Promise<string> {
    const history = await this.loadHistory(agentId, sessionId)
    const source = history.find(entry => entry.runId === runId)

    if (source === undefined) {
      throw new BranchNotFoundError(sessionId, runId)
    }

    const newSessionId = randomUUID()
    const now = new Date().toISOString()

    const synthetic: StoredRun = {
      agentId,
      runId: randomUUID(),
      sessionId: newSessionId,
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
