// NOTE: These store error classes are deliberately re-declared (byte-identically)
// in each store package — @noetaris/harness-store, -store-postgres, -store-redis —
// rather than shared from one package. This keeps the heavy-dependency stores
// (postgres, redis) from taking a runtime dependency on @noetaris/harness-store
// just to obtain error classes. Consumers catch these by class within each
// package's own public API; identity is not shared across package boundaries.

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
 * Thrown by {@link SessionStore.extendClaim} when the claim key no longer
 * exists or the nonce does not match.
 *
 * This means the lease has already expired (another instance may have claimed
 * the session) or was released. The framework detects the actual expiry at the
 * next step boundary via the local `lease.expiresAt` check.
 */
export class LeaseNotFoundError extends Error {
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`claim for session "${sessionId}" not found or nonce mismatch — lease may have expired`)
    this.name = 'LeaseNotFoundError'
    this.sessionId = sessionId
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
