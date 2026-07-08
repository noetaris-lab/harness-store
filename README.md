# @noetaris/harness-store

Session store implementations for [@noetaris/harness](https://github.com/noetaris-lab/harness). This package provides the `SessionStore` interface implementations needed to persist and manage agent execution state.

## Overview

`@noetaris/harness-store` implements session persistence for the Harness agent framework. It decouples storage mechanics from the core harness, allowing you to choose or implement the storage backend that fits your application.

Currently provides:
- **InMemorySessionStore** — In-memory implementation for development, testing, and ephemeral sessions
- **LocalFileSessionStore** — File-system implementation that persists sessions as JSONL files, surviving process restarts

For production deployments, use a dedicated store package:
- [`@noetaris/harness-store-redis`](https://github.com/noetaris-lab/harness-store-redis) — Redis-backed store with atomic Lua CAS and distributed claim/lease
- [`@noetaris/harness-store-postgres`](https://github.com/noetaris-lab/harness-store-postgres) — PostgreSQL-backed store with full history and branching support

## Installation

```bash
pnpm add @noetaris/harness-store
```

This package has **zero runtime dependencies** — it does not declare `@noetaris/harness`
as a peer dependency and does not require it at runtime. The store implementations
satisfy the `SessionStore` contract via TypeScript structural typing, so `@noetaris/harness`
is only needed at build time if you want its `SessionStore`/`StoredRun` types for your
own code (install it as a dev dependency in that case).

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
- Creates a synthetic `StoredRun` with `phase: 'paused'` and identical `initialState` and `finalState`
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

Thrown by `InMemorySessionStore` and `LocalFileSessionStore`.

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

Thrown by custom `SessionStore` implementations that support the optional `extendClaim()` method. The framework's `ctx.keepAlive()` handles this internally — callers of `ctx.keepAlive()` do not need to catch it.

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

For production use, see [`@noetaris/harness-store-redis`](https://github.com/noetaris-lab/harness-store-redis) (multi-process, distributed) or [`@noetaris/harness-store-postgres`](https://github.com/noetaris-lab/harness-store-postgres) (durable, full history).

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