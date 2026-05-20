/**
 * Thrown by {@link InMemorySessionStore.branch} and {@link LocalFileSessionStore.branch}
 * when no run with the requested `runId` exists in the session's history.
 */
export class BranchNotFoundError extends Error {
  constructor(sessionId: string, runId: string) {
    super(`branch target not found: sessionId=${sessionId}, runId=${runId}`)
    this.name = 'BranchNotFoundError'
  }
}
