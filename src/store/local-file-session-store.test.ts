import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, readFile, readdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { StoredRun } from '@noetaris/harness'
import { LocalFileSessionStore } from './local-file-session-store.js'
import { BranchNotFoundError } from '../errors.js'
import { LocalFileSessionStore as IndexLocalFileSessionStore } from '../index.js'

function makeRun(overrides: Partial<StoredRun & { agentId: string }> = {}): StoredRun {
  return {
    agentId: 'agent-default',
    runId: 'run-default',
    sessionId: 's-default',
    startedAt: new Date().toISOString(),
    settledAt: new Date().toISOString(),
    phase: 'completed',
    initialState: {},
    finalState: {},
    ...overrides,
  }
}

let tmpDir: string

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'lfss-test-'))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('LocalFileSessionStore', () => {

  describe('file path construction', () => {

    it('uses correct path pattern {dir}/{agentId}_{sessionId}.jsonl', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'myAgent', sessionId: 'abc123' })
      await store.save('myAgent', 'abc123', r1)

      // act
      const exists = await access(join(tmpDir, 'myAgent_abc123.jsonl')).then(() => true).catch(() => false)

      // assert
      expect(exists).toBe(true)
    })

    it('normalizes trailing slash on dir (no double slash in path)', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir + '/' })
      const r1 = makeRun({ agentId: 'myAgent', sessionId: 'abc123' })
      await store.save('myAgent', 'abc123', r1)

      // act
      const exists = await access(join(tmpDir, 'myAgent_abc123.jsonl')).then(() => true).catch(() => false)

      // assert
      expect(exists).toBe(true)
    })

  })

  describe('load', () => {

    it('returns null when no file exists for the session', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })

      // act
      const result = await store.load('agentA', 'new-sess')

      // assert
      expect(result).toBeNull()
    })

    it('returns the saved run after a single save', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-2-2', runId: 'run-a' })
      await store.save('agentA', 'sess-2-2', r1)

      // act
      const result = await store.load('agentA', 'sess-2-2')

      // assert
      expect(result).toEqual(r1)
    })

    it('returns the most recently saved run when multiple runs exist', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-2-3', runId: 'run-a' })
      const r2 = makeRun({ agentId: 'agentA', sessionId: 'sess-2-3', runId: 'run-b' })
      await store.save('agentA', 'sess-2-3', r1)
      await store.save('agentA', 'sess-2-3', r2)

      // act
      const result = await store.load('agentA', 'sess-2-3')

      // assert
      expect(result).toEqual(r2)
    })

    it('returns null for a different sessionId even when another session was saved', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-2-4a', runId: 'run-a' })
      await store.save('agentA', 'sess-2-4a', r1)

      // act
      const miss = await store.load('agentA', 'sess-2-4b')
      const hit = await store.load('agentA', 'sess-2-4a')

      // assert
      expect(miss).toBeNull()
      expect(hit).toEqual(r1)
    })

    it('returns null for a different agentId even when another agent\'s session was saved', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-2-5', runId: 'run-a' })
      await store.save('agentA', 'sess-2-5', r1)

      // act
      const miss = await store.load('agentB', 'sess-2-5')
      const hit = await store.load('agentA', 'sess-2-5')

      // assert
      expect(miss).toBeNull()
      expect(hit).toEqual(r1)
    })

    it('ignores trailing empty lines and returns the last non-empty line', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-2-6', runId: 'run-a' })
      const r2 = makeRun({ agentId: 'agentA', sessionId: 'sess-2-6', runId: 'run-b' })
      await store.save('agentA', 'sess-2-6', r1)
      await store.save('agentA', 'sess-2-6', r2)

      // act
      const result = await store.load('agentA', 'sess-2-6')

      // assert
      expect(result).toEqual(r2)
    })

  })

  describe('save', () => {

    it('creates the session file on first save with exactly one JSON line', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-3-1', runId: 'run-a' })

      // act
      await store.save('agentA', 'sess-3-1', r1)

      // assert
      const content = await readFile(join(tmpDir, 'agentA_sess-3-1.jsonl'), 'utf8')
      const lines = content.split('\n').filter(l => l.length > 0)
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]!)).toEqual(r1)
    })

    it('appends a second run to the existing file; both lines present in order', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-3-2', runId: 'run-a' })
      const r2 = makeRun({ agentId: 'agentA', sessionId: 'sess-3-2', runId: 'run-b' })
      await store.save('agentA', 'sess-3-2', r1)

      // act
      await store.save('agentA', 'sess-3-2', r2)

      // assert
      const content = await readFile(join(tmpDir, 'agentA_sess-3-2.jsonl'), 'utf8')
      const lines = content.split('\n').filter(l => l.length > 0)
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]!)).toEqual(r1)
      expect(JSON.parse(lines[1]!)).toEqual(r2)
    })

    it('serializes a full StoredRun with optional fields faithfully', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-3-3', runId: 'run-a', signal: 'stop', step: '3' })

      // act
      await store.save('agentA', 'sess-3-3', r1)

      // assert
      const content = await readFile(join(tmpDir, 'agentA_sess-3-3.jsonl'), 'utf8')
      const lines = content.split('\n').filter(l => l.length > 0)
      expect(JSON.parse(lines[0]!)).toEqual(r1)
    })

    it('does not write to other sessions\' files', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-3-4a', runId: 'run-a' })
      await store.save('agentA', 'sess-3-4a', r1)

      // act
      const r2 = makeRun({ agentId: 'agentA', sessionId: 'sess-3-4b', runId: 'run-b' })
      await store.save('agentA', 'sess-3-4b', r2)

      // assert
      const content1 = await readFile(join(tmpDir, 'agentA_sess-3-4a.jsonl'), 'utf8')
      const lines1 = content1.split('\n').filter(l => l.length > 0)
      expect(lines1).toHaveLength(1)
      expect(JSON.parse(lines1[0]!)).toEqual(r1)
      const content2 = await readFile(join(tmpDir, 'agentA_sess-3-4b.jsonl'), 'utf8')
      const lines2 = content2.split('\n').filter(l => l.length > 0)
      expect(lines2).toHaveLength(1)
      expect(JSON.parse(lines2[0]!)).toEqual(r2)
    })

  })

  describe('loadHistory', () => {

    it('returns empty array when no file exists for the session', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })

      // act
      const result = await store.loadHistory('agentA', 'sess-4-1')

      // assert
      expect(result).toEqual([])
    })

    it('returns single-element array after one save', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-4-2', runId: 'run-a' })
      await store.save('agentA', 'sess-4-2', r1)

      // act
      const result = await store.loadHistory('agentA', 'sess-4-2')

      // assert
      expect(result).toEqual([r1])
    })

    it('returns all runs in insertion order with three saves', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-4-3', runId: 'run-a' })
      const r2 = makeRun({ agentId: 'agentA', sessionId: 'sess-4-3', runId: 'run-b' })
      const r3 = makeRun({ agentId: 'agentA', sessionId: 'sess-4-3', runId: 'run-c' })
      await store.save('agentA', 'sess-4-3', r1)
      await store.save('agentA', 'sess-4-3', r2)
      await store.save('agentA', 'sess-4-3', r3)

      // act
      const result = await store.loadHistory('agentA', 'sess-4-3')

      // assert
      expect(result).toEqual([r1, r2, r3])
    })

    it('does not include runs from other sessions', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-4-4a', runId: 'run-a' })
      const r2 = makeRun({ agentId: 'agentA', sessionId: 'sess-4-4b', runId: 'run-b' })
      await store.save('agentA', 'sess-4-4a', r1)
      await store.save('agentA', 'sess-4-4b', r2)

      // act
      const result = await store.loadHistory('agentA', 'sess-4-4a')

      // assert
      expect(result).toEqual([r1])
    })

    it('mutations to the returned array do not affect a subsequent loadHistory call', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-4-5', runId: 'run-a' })
      const r2 = makeRun({ agentId: 'agentA', sessionId: 'sess-4-5', runId: 'run-b' })
      await store.save('agentA', 'sess-4-5', r1)

      // act
      const first = await store.loadHistory('agentA', 'sess-4-5')
      first.push(r2)
      const second = await store.loadHistory('agentA', 'sess-4-5')

      // assert
      expect(second).toEqual([r1])
    })

  })

  describe('branch — error cases', () => {

    it('throws BranchNotFoundError when no file exists for the session; no new file created', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const before = await readdir(tmpDir)

      // act
      const result = store.branch('agentA', 'sess-5-1', 'run-x')

      // assert
      await expect(result).rejects.toThrow(BranchNotFoundError)
      const after = await readdir(tmpDir)
      expect(after).toEqual(before)
    })

    it('throws BranchNotFoundError when session file exists but runId is absent; no new file created', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-5-2', runId: 'run-a' })
      await store.save('agentA', 'sess-5-2', r1)
      const before = await readdir(tmpDir)

      // act
      const result = store.branch('agentA', 'sess-5-2', 'run-missing')

      // assert
      await expect(result).rejects.toThrow(BranchNotFoundError)
      const after = await readdir(tmpDir)
      expect(after).toEqual(before)
    })

  })

  describe('branch — successful branch', () => {

    it('returns a new non-empty UUID v4 string different from the source session ID', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-6-1', runId: 'run-a', finalState: { x: 1 } })
      await store.save('agentA', 'sess-6-1', r1)

      // act
      const newSessionId = await store.branch('agentA', 'sess-6-1', 'run-a')

      // assert
      expect(newSessionId).not.toBe('sess-6-1')
      expect(newSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    })

    it('new session file has synthetic record with correct finalState and phase completed', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-6-2', runId: 'run-a', finalState: { x: 42 } })
      await store.save('agentA', 'sess-6-2', r1)

      // act
      const newSessionId = await store.branch('agentA', 'sess-6-2', 'run-a')
      const loaded = await store.load('agentA', newSessionId)

      // assert
      expect(loaded).not.toBeNull()
      expect(loaded!.finalState).toEqual({ x: 42 })
      expect(loaded!.phase).toBe('completed')
    })

    it('synthetic record has distinct runId and sessionId equal to newSessionId', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-6-3', runId: 'run-a' })
      await store.save('agentA', 'sess-6-3', r1)

      // act
      const newSessionId = await store.branch('agentA', 'sess-6-3', 'run-a')
      const loaded = await store.load('agentA', newSessionId)

      // assert
      expect(loaded!.sessionId).toBe(newSessionId)
      expect(loaded!.runId).not.toBe('run-a')
      expect(loaded!.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    })

    it('synthetic record preserves the agentId passed to branch', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-6-4', runId: 'run-a' })
      await store.save('agentA', 'sess-6-4', r1)

      // act
      const newSessionId = await store.branch('agentA', 'sess-6-4', 'run-a')
      const loaded = await store.load('agentA', newSessionId)

      // assert
      expect(loaded!.agentId).toBe('agentA')
    })

    it('new session appears in its own loadHistory with length 1 and correct fields', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-6-5', runId: 'run-a', finalState: { x: 42 } })
      await store.save('agentA', 'sess-6-5', r1)

      // act
      const newSessionId = await store.branch('agentA', 'sess-6-5', 'run-a')
      const history = await store.loadHistory('agentA', newSessionId)

      // assert
      expect(history).toHaveLength(1)
      expect(history[0]!.sessionId).toBe(newSessionId)
      expect(history[0]!.finalState).toEqual({ x: 42 })
    })

    it('source session file is not modified after a successful branch', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-6-6', runId: 'run-a' })
      await store.save('agentA', 'sess-6-6', r1)

      // act
      await store.branch('agentA', 'sess-6-6', 'run-a')
      const sourceHistory = await store.loadHistory('agentA', 'sess-6-6')
      const sourceLatest = await store.load('agentA', 'sess-6-6')

      // assert
      expect(sourceHistory).toEqual([r1])
      expect(sourceLatest).toEqual(r1)
    })

    it('branches from the correct run when multiple runs are in history', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-6-7', runId: 'run-a', finalState: { x: 1 } })
      const r2 = makeRun({ agentId: 'agentA', sessionId: 'sess-6-7', runId: 'run-b', finalState: { x: 99 } })
      await store.save('agentA', 'sess-6-7', r1)
      await store.save('agentA', 'sess-6-7', r2)

      // act
      const newSessionId = await store.branch('agentA', 'sess-6-7', 'run-a')
      const loaded = await store.load('agentA', newSessionId)

      // assert
      expect(loaded!.finalState).toEqual({ x: 1 })
    })

    it('synthetic record has initialState equal to finalState of the source run', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-6-8', runId: 'run-a', finalState: { x: 42 } })
      await store.save('agentA', 'sess-6-8', r1)

      // act
      const newSessionId = await store.branch('agentA', 'sess-6-8', 'run-a')
      const loaded = await store.load('agentA', newSessionId)

      // assert
      expect(loaded!.initialState).toEqual(loaded!.finalState)
      expect(loaded!.initialState).toEqual({ x: 42 })
    })

    it('synthetic record has valid ISO 8601 startedAt and settledAt timestamps', async () => {
      // arrange
      const store = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-6-9', runId: 'run-a', finalState: {} })
      await store.save('agentA', 'sess-6-9', r1)

      // act
      const newSessionId = await store.branch('agentA', 'sess-6-9', 'run-a')
      const loaded = await store.load('agentA', newSessionId)

      // assert
      expect(loaded!.startedAt).toBeTruthy()
      expect(loaded!.settledAt).toBeTruthy()
      expect(() => new Date(loaded!.startedAt).toISOString()).not.toThrow()
      expect(() => new Date(loaded!.settledAt).toISOString()).not.toThrow()
    })

  })

  describe('cross-process persistence (process restart simulation)', () => {

    it('load on a new store instance returns the run saved by the previous instance', async () => {
      // arrange
      const store1 = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-7-1', runId: 'run-a' })
      await store1.save('agentA', 'sess-7-1', r1)

      // act
      const store2 = new LocalFileSessionStore({ dir: tmpDir })
      const result = await store2.load('agentA', 'sess-7-1')

      // assert
      expect(result).toEqual(r1)
    })

    it('loadHistory on a new store instance returns all runs saved by the previous instance', async () => {
      // arrange
      const store1 = new LocalFileSessionStore({ dir: tmpDir })
      const r1 = makeRun({ agentId: 'agentA', sessionId: 'sess-7-2', runId: 'run-a' })
      const r2 = makeRun({ agentId: 'agentA', sessionId: 'sess-7-2', runId: 'run-b' })
      await store1.save('agentA', 'sess-7-2', r1)
      await store1.save('agentA', 'sess-7-2', r2)

      // act
      const store2 = new LocalFileSessionStore({ dir: tmpDir })
      const result = await store2.loadHistory('agentA', 'sess-7-2')

      // assert
      expect(result).toEqual([r1, r2])
    })

  })

  describe('public API exports', () => {

    it('LocalFileSessionStore is exported and has all four interface methods', () => {
      // arrange
      const store = new IndexLocalFileSessionStore({ dir: '/tmp' })

      // act + assert
      expect(typeof store.load).toBe('function')
      expect(typeof store.save).toBe('function')
      expect(typeof store.loadHistory).toBe('function')
      expect(typeof store.branch).toBe('function')
    })

  })

})
