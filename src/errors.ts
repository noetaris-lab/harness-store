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

/**
 * Thrown by {@link SessionStore.save} implementations when the stored record's
 * version does not match the version in the provided `StoredRun`.
 *
 * This indicates a concurrent write — another process committed a newer version
 * between the `load()` and this `save()` call.  The caller must reload and retry.
 */
export class ConcurrentModificationError extends Error {
  /** The session whose version conflicted. */
  readonly sessionId: string
  /** The version the caller tried to write. */
  readonly attemptedVersion: number
  /** The version currently in the store. */
  readonly storedVersion: number

  constructor(sessionId: string, attemptedVersion: number, storedVersion: number) {
    super(
      `session "${sessionId}" was modified concurrently — attempted version ${attemptedVersion}, stored version ${storedVersion}`,
    )
    this.name = 'ConcurrentModificationError'
    this.sessionId = sessionId
    this.attemptedVersion = attemptedVersion
    this.storedVersion = storedVersion
  }
}
