import { describe, it, expect } from 'vitest'
import type { StoredRun } from '@noetaris/harness'
import { InMemorySessionStore } from './in-memory-session-store.js'
import { BranchNotFoundError } from '../errors.js'

function makeRun(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
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

describe('InMemorySessionStore', () => {

  describe('load', () => {

    it('returns null when no run has been saved for the session', async () => {
      // arrange
      const store = new InMemorySessionStore()

      // act
      const result = await store.load('s1')

      // assert
      expect(result).toBeNull()
    })

    it('returns the saved run when the session exists', async () => {
      // arrange
      const store = new InMemorySessionStore()
      const r1 = makeRun({ runId: 'run-a', sessionId: 's1' })
      await store.save('s1', r1)

      // act
      const result = await store.load('s1')

      // assert
      expect(result).toEqual(r1)
    })

    it('returns the most recently saved run when multiple runs exist', async () => {
      // arrange
      const store = new InMemorySessionStore()
      const r1 = makeRun({ runId: 'run-a', sessionId: 's1' })
      const r2 = makeRun({ runId: 'run-b', sessionId: 's1' })
      await store.save('s1', r1)
      await store.save('s1', r2)

      // act
      const result = await store.load('s1')

      // assert
      expect(result).toEqual(r2)
    })

    it('returns null for a different session after another session is saved', async () => {
      // arrange
      const store = new InMemorySessionStore()
      const r1 = makeRun({ runId: 'run-a', sessionId: 's1' })
      await store.save('s1', r1)

      // act
      const s2Result = await store.load('s2')
      const s1Result = await store.load('s1')

      // assert
      expect(s2Result).toBeNull()
      expect(s1Result).toEqual(r1)
    })

  })

  describe('save', () => {

    it('persists a run so that load returns it', async () => {
      // arrange
      const store = new InMemorySessionStore()
      const r1 = makeRun({ runId: 'run-a', sessionId: 's1' })

      // act
      await store.save('s1', r1)

      // assert
      expect(await store.load('s1')).toEqual(r1)
    })

    it('appends both runs to history in insertion order', async () => {
      // arrange
      const store = new InMemorySessionStore()
      const r1 = makeRun({ runId: 'run-a', sessionId: 's1' })
      const r2 = makeRun({ runId: 'run-b', sessionId: 's1' })
      await store.save('s1', r1)
      await store.save('s1', r2)

      // act
      const history = await store.loadHistory('s1')

      // assert
      expect(history).toHaveLength(2)
      expect(history[0]).toEqual(r1)
      expect(history[1]).toEqual(r2)
    })

    it('does not affect other sessions', async () => {
      // arrange
      const store = new InMemorySessionStore()
      const r1 = makeRun({ runId: 'run-a', sessionId: 's1' })
      await store.save('s1', r1)

      // act
      const result = await store.load('s2')

      // assert
      expect(result).toBeNull()
    })

  })

  describe('loadHistory', () => {

    it('returns an empty array when no runs have been saved', async () => {
      // arrange
      const store = new InMemorySessionStore()

      // act
      const result = await store.loadHistory('s1')

      // assert
      expect(result).toEqual([])
    })

    it('returns a single-element array after one save', async () => {
      // arrange
      const store = new InMemorySessionStore()
      const r1 = makeRun({ runId: 'run-a', sessionId: 's1' })
      await store.save('s1', r1)

      // act
      const result = await store.loadHistory('s1')

      // assert
      expect(result).toEqual([r1])
    })

    it('returns all runs in insertion order oldest first', async () => {
      // arrange
      const store = new InMemorySessionStore()
      const r1 = makeRun({ runId: 'run-a', sessionId: 's1' })
      const r2 = makeRun({ runId: 'run-b', sessionId: 's1' })
      const r3 = makeRun({ runId: 'run-c', sessionId: 's1' })
      await store.save('s1', r1)
      await store.save('s1', r2)
      await store.save('s1', r3)

      // act
      const result = await store.loadHistory('s1')

      // assert
      expect(result).toEqual([r1, r2, r3])
    })

    it('mutations to the returned array do not affect the store internal history', async () => {
      // arrange
      const store = new InMemorySessionStore()
      const r1 = makeRun({ runId: 'run-a', sessionId: 's1' })
      const r2 = makeRun({ runId: 'run-b', sessionId: 's1' })
      await store.save('s1', r1)

      // act
      const first = await store.loadHistory('s1')
      first.push(r2)
      const second = await store.loadHistory('s1')

      // assert
      expect(second).toEqual([r1])
    })

    it('does not include runs from other sessions', async () => {
      // arrange
      const store = new InMemorySessionStore()
      const r1 = makeRun({ runId: 'run-a', sessionId: 's1' })
      const r2 = makeRun({ runId: 'run-b', sessionId: 's2' })
      await store.save('s1', r1)
      await store.save('s2', r2)

      // act
      const result = await store.loadHistory('s1')

      // assert
      expect(result).toEqual([r1])
    })

  })

  describe('branch', () => {

    it('throws BranchNotFoundError when the session has no history', async () => {
      // arrange
      const store = new InMemorySessionStore()

      // act
      const result = store.branch('s1', 'run-x')

      // assert
      await expect(result).rejects.toThrow(BranchNotFoundError)
    })

    it('throws BranchNotFoundError when session exists but runId is not in history', async () => {
      // arrange
      const store = new InMemorySessionStore()
      const r1 = makeRun({ runId: 'run-a', sessionId: 's1' })
      await store.save('s1', r1)

      // act
      const result = store.branch('s1', 'run-b')

      // assert
      await expect(result).rejects.toThrow(BranchNotFoundError)
      expect(await store.loadHistory('s1')).toEqual([r1])
    })

    it('returns a new UUID v4 string different from the source session ID', async () => {
      // arrange
      const store = new InMemorySessionStore()
      const r1 = makeRun({ runId: 'run-a', sessionId: 's1', finalState: { x: 42 } })
      await store.save('s1', r1)

      // act
      const newSessionId = await store.branch('s1', 'run-a')

      // assert
      expect(newSessionId).not.toBe('s1')
      expect(newSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    })

    it('new session is seeded with source finalState and phase completed', async () => {
      // arrange
      const store = new InMemorySessionStore()
      const r1 = makeRun({ runId: 'run-a', sessionId: 's1', finalState: { x: 42 } })
      await store.save('s1', r1)

      // act
      const newSessionId = await store.branch('s1', 'run-a')
      const loaded = await store.load(newSessionId)

      // assert
      expect(loaded).not.toBeNull()
      expect(loaded!.finalState).toEqual({ x: 42 })
      expect(loaded!.phase).toBe('completed')
    })

    it('new session StoredRun has the correct sessionId and a distinct runId', async () => {
      // arrange
      const store = new InMemorySessionStore()
      const r1 = makeRun({ runId: 'run-a', sessionId: 's1', finalState: { x: 42 } })
      await store.save('s1', r1)

      // act
      const newSessionId = await store.branch('s1', 'run-a')
      const loaded = await store.load(newSessionId)

      // assert
      expect(loaded!.sessionId).toBe(newSessionId)
      expect(loaded!.runId).not.toBe('run-a')
    })

    it('new session appears in its own history with length 1 and correct fields', async () => {
      // arrange
      const store = new InMemorySessionStore()
      const r1 = makeRun({ runId: 'run-a', sessionId: 's1', finalState: { x: 42 } })
      await store.save('s1', r1)

      // act
      const newSessionId = await store.branch('s1', 'run-a')
      const history = await store.loadHistory(newSessionId)

      // assert
      expect(history).toHaveLength(1)
      expect(history[0]!.sessionId).toBe(newSessionId)
      expect(history[0]!.finalState).toEqual({ x: 42 })
    })

    it('source session is unchanged after a successful branch', async () => {
      // arrange
      const store = new InMemorySessionStore()
      const r1 = makeRun({ runId: 'run-a', sessionId: 's1', finalState: { x: 1 } })
      await store.save('s1', r1)

      // act
      await store.branch('s1', 'run-a')
      const sourceHistory = await store.loadHistory('s1')
      const sourceLatest = await store.load('s1')

      // assert
      expect(sourceHistory).toEqual([r1])
      expect(sourceLatest).toEqual(r1)
    })

    it('branches from the correct run when multiple runs are in history', async () => {
      // arrange
      const store = new InMemorySessionStore()
      const r1 = makeRun({ runId: 'run-a', sessionId: 's1', finalState: { x: 1 } })
      const r2 = makeRun({ runId: 'run-b', sessionId: 's1', finalState: { x: 99 } })
      await store.save('s1', r1)
      await store.save('s1', r2)

      // act
      const newSessionId = await store.branch('s1', 'run-a')
      const loaded = await store.load(newSessionId)

      // assert
      expect(loaded!.finalState).toEqual({ x: 1 })
    })

    it('synthetic record has initialState equal to finalState', async () => {
      // arrange
      const store = new InMemorySessionStore()
      const r1 = makeRun({ runId: 'run-a', sessionId: 's1', finalState: { x: 42 } })
      await store.save('s1', r1)

      // act
      const newSessionId = await store.branch('s1', 'run-a')
      const loaded = await store.load(newSessionId)

      // assert
      expect(loaded!.initialState).toEqual(loaded!.finalState)
      expect(loaded!.initialState).toEqual({ x: 42 })
    })

    it('synthetic record has non-empty ISO 8601 startedAt and settledAt timestamps', async () => {
      // arrange
      const store = new InMemorySessionStore()
      const r1 = makeRun({ runId: 'run-a', sessionId: 's1', finalState: {} })
      await store.save('s1', r1)

      // act
      const newSessionId = await store.branch('s1', 'run-a')
      const loaded = await store.load(newSessionId)

      // assert
      expect(loaded!.startedAt).toBeTruthy()
      expect(loaded!.settledAt).toBeTruthy()
      expect(() => new Date(loaded!.startedAt).toISOString()).not.toThrow()
      expect(() => new Date(loaded!.settledAt).toISOString()).not.toThrow()
    })

  })

  describe('public API exports via index', () => {

    it('InMemorySessionStore is exported and has all four interface methods', async () => {
      // arrange
      const { InMemorySessionStore: ExportedStore } = await import('../index.js')
      const store = new ExportedStore()

      // act / assert
      expect(typeof store.load).toBe('function')
      expect(typeof store.save).toBe('function')
      expect(typeof store.loadHistory).toBe('function')
      expect(typeof store.branch).toBe('function')
    })

    it('BranchNotFoundError is exported and is an Error subclass', async () => {
      // arrange
      const { BranchNotFoundError: ExportedError } = await import('../index.js')
      const err = new ExportedError('s1', 'run-x')

      // act / assert
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(ExportedError)
      expect(err.name).toBe('BranchNotFoundError')
      expect(err.message).toContain('s1')
      expect(err.message).toContain('run-x')
    })

  })

})
