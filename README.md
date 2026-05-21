# @noetaris/harness-store

Session store implementations for [@noetaris/harness](../core). This package provides the `SessionStore` interface implementations needed to persist and manage agent execution state.

## Overview

`@noetaris/harness-store` implements session persistence for the Harness agent framework. It decouples storage mechanics from the core harness, allowing you to choose or implement the storage backend that fits your application.

Currently provides:
- **InMemorySessionStore** — In-memory implementation for development, testing, and ephemeral sessions
- **LocalFileSessionStore** — File-system implementation that persists sessions as JSONL files, surviving process restarts
- **RedisSessionStore** — Redis-backed implementation with atomic conditional save (Lua CAS) and distributed claim/lease via `SET NX PX` and Lua scripts. Suitable for multi-process, multi-machine deployments.

## Installation

```bash
pnpm add @noetaris/harness-store
```

Note: `@noetaris/harness` is required as a peer dependency.

```bash
pnpm add @noetaris/harness
```

## Quick Start

```typescript
import { InMemorySessionStore } from '@noetaris/harness-store'

const store = new InMemorySessionStore()
```

## API Reference

### `InMemorySessionStore`

An in-memory session store that keeps the latest run for each session and maintains a complete history.

#### `load(agentId: string, sessionId: string): Promise<StoredRun | null>`

Loads the most recent run for a session.

```typescript
const run = await store.load('my-agent', 'session-123')
if (run === null) {
  console.log('No runs found for this session')
} else {
  console.log(`Latest phase: ${run.phase}`)
}
```

**Returns:**
- The most recent `StoredRun` if one exists, or `null` if no runs have been saved for this agent/session pair

#### `save(agentId: string, sessionId: string, run: StoredRun): Promise<void>`

Persists a run to the store. The run becomes the latest for this session and is appended to the session's history.

```typescript
const run: StoredRun = {
  agentId: 'my-agent',
  runId: 'run-abc123',
  sessionId: 'session-123',
  startedAt: new Date().toISOString(),
  settledAt: new Date().toISOString(),
  phase: 'completed',
  initialState: { step: 0 },
  finalState: { step: 5, result: 'success' },
}

await store.save('my-agent', 'session-123', run)
```

#### `loadHistory(agentId: string, sessionId: string): Promise<StoredRun[]>`

Loads all runs for a session in insertion order (oldest first).

```typescript
const allRuns = await store.loadHistory('my-agent', 'session-123')
console.log(`Session has ${allRuns.length} runs`)
allRuns.forEach((run, i) => {
  console.log(`Run ${i}: ${run.runId} completed in ${run.phase}`)
})
```

**Returns:**
- An array of all `StoredRun` objects for the session, in chronological order
- Returns an empty array if no runs exist for the session
- Returns a defensive copy; mutations don't affect the store

#### `branch(agentId: string, sessionId: string, runId: string): Promise<string>`

Creates a new session by branching from a specific run in another session's history. The new session is initialized with the source run's final state.

```typescript
try {
  const newSessionId = await store.branch('my-agent', 'session-original', 'run-abc123')
  console.log(`Created new session: ${newSessionId}`)
} catch (err) {
  if (err instanceof BranchNotFoundError) {
    console.log('Could not find the run to branch from')
  }
}
```

**Returns:**
- A new UUID v4 string for the branched session

**Throws:**
- `BranchNotFoundError` if the `runId` is not found in the source session's history

**Behavior:**
- Creates a synthetic `StoredRun` with `phase: 'completed'` and identical `initialState` and `finalState`
- The new session appears in its own history with a single run
- The source session is unaffected

## `LocalFileSessionStore`

A file-system-backed session store that persists each session as a JSONL file. Each line in the file is one `StoredRun` record, in append order.

**File layout:** `{dir}/{agentId}_{sessionId}.jsonl`

The `dir` directory must already exist — the constructor does not create it.

### Quick Start

```typescript
import { LocalFileSessionStore } from '@noetaris/harness-store'
import { mkdir } from 'node:fs/promises'

await mkdir('./sessions', { recursive: true })
const store = new LocalFileSessionStore({ dir: './sessions' })
```

### Constructor

```typescript
new LocalFileSessionStore(options: { dir: string })
```

| Option | Type | Description |
|--------|------|-------------|
| `dir` | `string` | Absolute or relative path to the directory where session files are stored. Must exist before construction. |

### Methods

All methods have the same signatures as `InMemorySessionStore`. See [`load`](#loadsessionid-string-promise), [`save`](#savesessionid-string-run-storedrun-promisevoid), [`loadHistory`](#loadhistorysessionid-string-promise), and [`branch`](#branchsessionid-string-runid-string-promisestring) above for parameter details.

### When to Use `LocalFileSessionStore`

**Good for:**
- Single-process services that need sessions to survive restarts
- Development and staging with durable state requirements
- Workloads where each agent runs on one machine

**Not suitable for:**
- Multi-process or multi-machine deployments (concurrent writes to the same file are unsafe)
- High-throughput workloads (file I/O per step)

## `RedisSessionStore`

A Redis-backed session store with atomic conditional save (Lua CAS) and full distributed claim/lease support. Designed for multi-process, multi-machine deployments.

**Requires:** `ioredis` (already a runtime dependency of `@noetaris/harness-store`).

### Quick Start

```typescript
import { RedisSessionStore } from '@noetaris/harness-store'
import Redis from 'ioredis'

const client = new Redis(process.env.REDIS_URL)
const store = new RedisSessionStore({ client })
```

### Constructor

```typescript
new RedisSessionStore(options: RedisSessionStoreOptions)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `client` | `Redis` | required | A pre-constructed `ioredis` `Redis` instance. The store does not manage the connection lifecycle — connect before use, disconnect after. |
| `prefix` | `string` | `"harness"` | Key prefix prepended to all Redis keys (e.g. `harness:runs:{agentId}:{sessionId}`). Empty string falls back to `"harness"`. |

### Key Schema

Two key types per session:
- `{prefix}:runs:{agentId}:{sessionId}` — latest `StoredRun`, JSON-serialized
- `{prefix}:claims:{agentId}:{sessionId}` — claim record with TTL (set by `claim`, deleted by `release`)

### Distributed Concurrency

`RedisSessionStore` implements the full two-layer hybrid concurrency model:

- **Layer 1 — Optimistic locking (mandatory):** `save()` uses a Lua script to atomically compare the stored version before writing. Throws `ConcurrentModificationError` on mismatch.
- **Layer 2 — Claim/lease (optional):** `claim()` uses `SET NX PX`; `release()` and `extendClaim()` use nonce-guarded Lua scripts. A random UUID nonce is generated at claim time and verified server-side — stale leases from previous claim periods cannot release or extend a new holder's lock.

See [Distributed Deployment](../docs/distributed-deployment.md) for the full concurrency model.

### Limitations

- `loadHistory` and `branch` are not implemented — Redis stores only the latest run per session.
- Redis Cluster topology with multi-key Lua scripts requires hash tags (out of scope).
- Connection management is the caller's responsibility.

### When to Use `RedisSessionStore`

**Good for:**
- Multi-process and multi-machine deployments
- Production systems requiring durable, cross-instance session state
- Deployments that need distributed locking (`claim`/`release`) to prevent concurrent runs on the same session

**Not suitable for:**
- Single-process development (use `InMemorySessionStore` instead)
- Workloads requiring full session history (use `LocalFileSessionStore` or a database-backed store)

## Error Handling

### `BranchNotFoundError`

Thrown when attempting to branch from a run that doesn't exist.

```typescript
import { BranchNotFoundError } from '@noetaris/harness-store'

try {
  await store.branch('my-agent', 'session-123', 'nonexistent-run')
} catch (err) {
  if (err instanceof BranchNotFoundError) {
    console.error(`Failed to branch: ${err.message}`)
  }
}
```

The error message includes the session ID and run ID for debugging:
```
branch target not found: sessionId=session-123, runId=nonexistent-run
```

### `ConcurrentModificationError`

Thrown by `save()` when a concurrent write is detected via optimistic locking. The stored version did not match the expected version — another instance committed between your `load` and `save`.

```typescript
import { ConcurrentModificationError } from '@noetaris/harness-store'

try {
  await store.save('my-agent', 'session-123', run)
} catch (err) {
  if (err instanceof ConcurrentModificationError) {
    console.error(`Concurrent write conflict: ${err.message}`)
    // err.sessionId — the session that conflicted
    // err.attemptedVersion — the version that was rejected
  }
}
```

Thrown by `InMemorySessionStore`, `LocalFileSessionStore`, and `RedisSessionStore`.

### `LeaseNotFoundError`

Thrown by `extendClaim()` when the claim key no longer exists or the nonce does not match. This means the lease has expired (another instance may have claimed the session) or was already released.

```typescript
import { LeaseNotFoundError } from '@noetaris/harness-store'

try {
  const newLease = await store.extendClaim(lease, { ttlMs: 10_000 })
} catch (err) {
  if (err instanceof LeaseNotFoundError) {
    console.error(`Lease gone: ${err.message}`)
    // err.sessionId — the session whose claim was not found
  }
}
```

Thrown by `RedisSessionStore`. The framework's `ctx.keepAlive()` handles this internally — callers of `ctx.keepAlive()` do not need to catch it.

## When to Use `InMemorySessionStore`

**Good for:**
- Development and local testing
- Ephemeral agent sessions that don't need persistence across restarts
- Unit tests and integration tests
- Prototyping new harness features

**Not suitable for:**
- Production systems requiring durability
- Multi-process deployments (data lost on restart)
- Audit or compliance requirements

For production use, implement `SessionStore` with your preferred storage backend (database, file system, cloud storage, etc.).

## Implementing Custom Stores

To create your own store, implement the `SessionStore` interface from `@noetaris/harness`:

```typescript
import type { SessionStore, StoredRun } from '@noetaris/harness'

export class MyCustomStore implements SessionStore {
  async load(agentId: string, sessionId: string): Promise<StoredRun | null> {
    // TODO: implement
  }

  async save(agentId: string, sessionId: string, run: StoredRun): Promise<void> {
    // TODO: implement
  }

  // Optional — enables session history queries
  async loadHistory(agentId: string, sessionId: string): Promise<StoredRun[]> {
    // TODO: implement
  }

  // Optional — enables session branching
  async branch(agentId: string, sessionId: string, runId: string): Promise<string> {
    // TODO: implement
  }

  // Optional — enables distributed claim/lease (Layer 2 concurrency)
  async claim(agentId: string, sessionId: string, options: ClaimOptions): Promise<Lease | null> {
    // TODO: implement — return Lease on success, null if already claimed
  }

  async release(lease: Lease): Promise<void> {
    // TODO: implement — must never reject; swallow errors
  }

  async extendClaim(lease: Lease, options: ClaimOptions): Promise<Lease> {
    // TODO: implement — throw LeaseNotFoundError if key absent or nonce mismatch
  }
}
```

`loadHistory`, `branch`, `claim`, `release`, and `extendClaim` are optional — only `load` and `save` are required by the interface. Implement `claim`/`release`/`extendClaim` to support multi-process distributed locking (Layer 2 concurrency). See the TypeScript interface in `@noetaris/harness` for the full contract.

## License

MIT