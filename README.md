# @noetaris/harness-store

Session store implementations for [@noetaris/harness](../core). This package provides the `SessionStore` interface implementations needed to persist and manage agent execution state.

## Overview

`@noetaris/harness-store` is a zero-dependency package that implements session persistence for the Harness agent framework. It decouples storage mechanics from the core harness, allowing you to choose or implement the storage backend that fits your application.

Currently provides:
- **InMemorySessionStore** — A simple in-memory implementation for development, testing, and ephemeral sessions

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

#### `load(sessionId: string): Promise<StoredRun | null>`

Loads the most recent run for a session.

```typescript
const run = await store.load('session-123')
if (run === null) {
  console.log('No runs found for this session')
} else {
  console.log(`Latest phase: ${run.phase}`)
}
```

**Returns:**
- The most recent `StoredRun` if one exists, or `null` if no runs have been saved for this session

#### `save(sessionId: string, run: StoredRun): Promise<void>`

Persists a run to the store. The run becomes the latest for this session and is appended to the session's history.

```typescript
const run: StoredRun = {
  runId: 'run-abc123',
  sessionId: 'session-123',
  startedAt: new Date().toISOString(),
  settledAt: new Date().toISOString(),
  phase: 'completed',
  initialState: { step: 0 },
  finalState: { step: 5, result: 'success' },
}

await store.save('session-123', run)
```

#### `loadHistory(sessionId: string): Promise<StoredRun[]>`

Loads all runs for a session in insertion order (oldest first).

```typescript
const allRuns = await store.loadHistory('session-123')
console.log(`Session has ${allRuns.length} runs`)
allRuns.forEach((run, i) => {
  console.log(`Run ${i}: ${run.runId} completed in ${run.phase}`)
})
```

**Returns:**
- An array of all `StoredRun` objects for the session, in chronological order
- Returns an empty array if no runs exist for the session
- Returns a defensive copy; mutations don't affect the store

#### `branch(sessionId: string, runId: string): Promise<string>`

Creates a new session by branching from a specific run in another session's history. The new session is initialized with the source run's final state.

```typescript
try {
  const sourceSession = 'session-original'
  const targetRun = 'run-abc123'

  const newSessionId = await store.branch(sourceSession, targetRun)
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

## Error Handling

### `BranchNotFoundError`

Thrown when attempting to branch from a run that doesn't exist.

```typescript
import { BranchNotFoundError } from '@noetaris/harness-store'

try {
  await store.branch('session-123', 'nonexistent-run')
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
  async load(sessionId: string): Promise<StoredRun | null> {
    // TODO: implement
  }

  async save(sessionId: string, run: StoredRun): Promise<void> {
    // TODO: implement
  }

  async loadHistory(sessionId: string): Promise<StoredRun[]> {
    // TODO: implement
  }

  async branch(sessionId: string, runId: string): Promise<string> {
    // TODO: implement
  }
}
```

See the TypeScript interface in `@noetaris/harness` for the full contract.

## License

MIT