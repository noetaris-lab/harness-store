export class BranchNotFoundError extends Error {
  constructor(sessionId: string, runId: string) {
    super(`branch target not found: sessionId=${sessionId}, runId=${runId}`)
    this.name = 'BranchNotFoundError'
  }
}
