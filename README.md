# @noetaris/harness-store

Session store implementations for [@noetaris/harness](../core). This package provides the `SessionStore` interface implementations needed to persist and manage agent execution state.

## Overview

`@noetaris/harness-store` is a zero-dependency package that implements session persistence for the Harness agent framework. It decouples storage mechanics from the core harness, allowing you to choose or implement the storage backend that fits your application.

Currently provides:
- **InMemorySessionStore** — In-memory implementation for development, testing, and ephemeral sessions
- **LocalFileSessionStore** — File-system implementation that persists sessions as JSONL files, surviving process restarts

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
}
```

`loadHistory` and `branch` are optional — only `load` and `save` are required by the interface. See the TypeScript interface in `@noetaris/harness` for the full contract.

## License

MIT