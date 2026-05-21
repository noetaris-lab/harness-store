import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { StoredRun, Lease } from '@noetaris/harness'
import { Redis } from 'ioredis'
import { RedisSessionStore } from './redis-session-store.js'
import { ConcurrentModificationError, LeaseNotFoundError } from '../errors.js'

function makeRun(overrides: Partial<StoredRun> = {}): StoredRun {
  return {
    agentId: 'agentA',
    runId: 'run-default',
    sessionId: 's-default',
    version: 0,
    startedAt: new Date().toISOString(),
    settledAt: new Date().toISOString(),
    phase: 'completed',
    initialState: {},
    finalState: {},
    ...overrides,
  }
}

const skipIfNoRedis = !process.env.REDIS_URL

describe('RedisSessionStore', () => {

  describe('key construction', () => {

    it('passes run key with explicit prefix "harness" to client.get', async () => {
      // arrange
      const fakeClient = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), eval: vi.fn() }
      const store = new RedisSessionStore({ client: fakeClient as unknown as Redis, prefix: 'harness' })

      // act
      await store.load('myAgent', 'sess1')

      // assert
      expect(fakeClient.get).toHaveBeenCalledOnce()
      expect(fakeClient.get).toHaveBeenCalledWith('harness:runs:myAgent:sess1')
    })

    it('passes run key with custom prefix to client.get', async () => {
      // arrange
      const fakeClient = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), eval: vi.fn() }
      const store = new RedisSessionStore({ client: fakeClient as unknown as Redis, prefix: 'myapp' })

      // act
      await store.load('myAgent', 'sess1')

      // assert
      expect(fakeClient.get).toHaveBeenCalledWith('myapp:runs:myAgent:sess1')
    })

    it('uses default prefix "harness" when no prefix option is supplied', async () => {
      // arrange
      const fakeClient = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), eval: vi.fn() }
      const store = new RedisSessionStore({ client: fakeClient as unknown as Redis })

      // act
      await store.load('myAgent', 'sess1')

      // assert
      expect(fakeClient.get).toHaveBeenCalledWith('harness:runs:myAgent:sess1')
    })

    it('normalizes empty-string prefix to default "harness"', async () => {
      // arrange
      const fakeClient = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), eval: vi.fn() }
      const store = new RedisSessionStore({ client: fakeClient as unknown as Redis, prefix: '' })

      // act
      await store.load('myAgent', 'sess1')

      // assert
      expect(fakeClient.get).toHaveBeenCalledWith('harness:runs:myAgent:sess1')
    })

    it('passes claim key with "claims" segment to client.set on claim()', async () => {
      // arrange
      const fakeClient = { get: vi.fn(), set: vi.fn().mockResolvedValue('OK'), eval: vi.fn() }
      const store = new RedisSessionStore({ client: fakeClient as unknown as Redis })

      // act
      await store.claim('myAgent', 'sess1', { ttlMs: 5000 })

      // assert
      expect(fakeClient.set).toHaveBeenCalledOnce()
      const firstCall = fakeClient.set.mock.calls[0]
      expect(firstCall).toBeDefined()
      expect(firstCall![0]).toBe('harness:claims:myAgent:sess1')
    })

  })

  describe('load — Redis-backed reads', () => {

    let client: Redis
    let store: RedisSessionStore

    beforeEach(async () => {
      if (skipIfNoRedis) return
      client = new Redis(process.env.REDIS_URL!)
      store = new RedisSessionStore({ client })
    })

    afterEach(async () => {
      if (skipIfNoRedis) return
      await client.flushdb()
      await client.quit()
    })

    it('returns null when run key is absent', { skip: skipIfNoRedis }, async () => {
      // arrange — database is empty from flushdb

      // act
      const result = await store.load('agentA', 'sess1')

      // assert
      expect(result).toBeNull()
    })

    it('returns the stored run after save', { skip: skipIfNoRedis }, async () => {
      // arrange
      const run1 = makeRun({ version: 0, sessionId: 'sess1', finalState: { x: 1 } })
      await store.save('agentA', 'sess1', run1)

      // act
      const result = await store.load('agentA', 'sess1')

      // assert
      expect(result).toEqual(run1)
    })

    it('returns null for an unsaved sessionId; saved session is unaffected', { skip: skipIfNoRedis }, async () => {
      // arrange
      const run1 = makeRun({ version: 0, sessionId: 'sess1', finalState: {} })
      await store.save('agentA', 'sess1', run1)

      // act
      const resultSess2 = await store.load('agentA', 'sess2')
      const resultSess1 = await store.load('agentA', 'sess1')

      // assert
      expect(resultSess2).toBeNull()
      expect(resultSess1).toEqual(run1)
    })

    it('returns null for a different agentId', { skip: skipIfNoRedis }, async () => {
      // arrange
      const run1 = makeRun({ version: 0, sessionId: 'sess1', finalState: {} })
      await store.save('agentA', 'sess1', run1)

      // act
      const result = await store.load('agentB', 'sess1')

      // assert
      expect(result).toBeNull()
    })

  })

  describe('save — conditional writes (optimistic locking)', () => {

    let client: Redis
    let store: RedisSessionStore

    beforeEach(async () => {
      if (skipIfNoRedis) return
      client = new Redis(process.env.REDIS_URL!)
      store = new RedisSessionStore({ client })
    })

    afterEach(async () => {
      if (skipIfNoRedis) return
      await client.flushdb()
      await client.quit()
    })

    it('resolves without error when saving version 0 on a non-existing key', { skip: skipIfNoRedis }, async () => {
      // arrange — database is empty
      const run0 = makeRun({ version: 0, phase: 'paused', finalState: {} })

      // act
      await store.save('agentA', 'sess1', run0)

      // assert
      const loaded = await store.load('agentA', 'sess1')
      expect(loaded).toEqual(run0)
    })

    it('resolves and replaces data when saving version 1 after version 0', { skip: skipIfNoRedis }, async () => {
      // arrange
      const run0 = makeRun({ version: 0, phase: 'paused', finalState: { step: 0 } })
      const run1 = makeRun({ runId: 'run-1', version: 1, phase: 'completed', finalState: { step: 1 } })
      await store.save('agentA', 'sess1', run0)

      // act
      await store.save('agentA', 'sess1', run1)

      // assert
      const loaded = await store.load('agentA', 'sess1')
      expect(loaded).toEqual(run1)
    })

    it('throws ConcurrentModificationError when saving stale version 0 over existing version 0', { skip: skipIfNoRedis }, async () => {
      // arrange
      const run0 = makeRun({ version: 0, phase: 'paused', finalState: {} })
      await store.save('agentA', 'sess1', run0)
      const run0Copy = makeRun({ runId: 'run-copy', version: 0, phase: 'paused', finalState: { extra: true } })

      // act
      const promise = store.save('agentA', 'sess1', run0Copy)

      // assert
      await expect(promise).rejects.toThrow(ConcurrentModificationError)
      await expect(store.save('agentA', 'sess1', run0Copy)).rejects.toMatchObject({
        sessionId: 'sess1',
        attemptedVersion: 0,
      })
      expect(await store.load('agentA', 'sess1')).toEqual(run0)
    })

    it('throws ConcurrentModificationError when version skips (2 instead of 1)', { skip: skipIfNoRedis }, async () => {
      // arrange
      await store.save('agentA', 'sess1', makeRun({ version: 0, phase: 'paused', finalState: {} }))
      const run2 = makeRun({ runId: 'run-skip', version: 2, phase: 'completed', finalState: {} })

      // act / assert
      await expect(store.save('agentA', 'sess1', run2)).rejects.toThrow(ConcurrentModificationError)
    })

    it('throws ConcurrentModificationError when saving version 1 on a non-existing key', { skip: skipIfNoRedis }, async () => {
      // arrange — database is empty

      // act / assert
      await expect(
        store.save('agentA', 'sess1', makeRun({ version: 1, phase: 'paused', finalState: {} }))
      ).rejects.toThrow(ConcurrentModificationError)
    })

    it('round-trips all StoredRun fields faithfully including metadata', { skip: skipIfNoRedis }, async () => {
      // arrange
      const fullRun: StoredRun = {
        agentId: 'agentA',
        runId: 'run-full',
        sessionId: 'sess1',
        version: 0,
        startedAt: '2026-01-01T00:00:00.000Z',
        settledAt: '2026-01-01T00:01:00.000Z',
        phase: 'paused',
        initialState: { init: true },
        finalState: { nested: { deep: true } },
        signal: 'pause',
        step: 'step-3',
        metadata: { instanceId: 'inst-abc', startedAt: 1234567890 },
      }
      await store.save('agentA', 'sess1', fullRun)

      // act
      const loaded = await store.load('agentA', 'sess1')

      // assert
      expect(loaded).toEqual(fullRun)
      expect(loaded?.metadata?.instanceId).toBe('inst-abc')
    })

  })

  describe('claim — distributed lock acquisition', () => {

    let client: Redis
    let store: RedisSessionStore

    beforeEach(async () => {
      if (skipIfNoRedis) return
      client = new Redis(process.env.REDIS_URL!)
      store = new RedisSessionStore({ client })
    })

    afterEach(async () => {
      if (skipIfNoRedis) return
      await client.flushdb()
      await client.quit()
    })

    it('returns a Lease with correct fields when claim key is absent', { skip: skipIfNoRedis }, async () => {
      // arrange
      const before = Date.now()

      // act
      const lease = await store.claim('agentA', 'sess1', { ttlMs: 5000 })

      // assert
      expect(lease).not.toBeNull()
      expect(lease!.agentId).toBe('agentA')
      expect(lease!.sessionId).toBe('sess1')
      expect(lease!.expiresAt).toBeGreaterThan(before)
      expect(lease!.expiresAt).toBeLessThanOrEqual(Date.now() + 5000 + 50)
      const token = lease!.token as { key: string; nonce: string }
      expect(typeof token.key).toBe('string')
      expect(token.key).toBe('harness:claims:agentA:sess1')
      expect(typeof token.nonce).toBe('string')
      expect(token.nonce).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('returns null when claim key already exists (lock already held)', { skip: skipIfNoRedis }, async () => {
      // arrange
      await store.claim('agentA', 'sess1', { ttlMs: 5000 })

      // act
      const lease = await store.claim('agentA', 'sess1', { ttlMs: 5000 })

      // assert
      expect(lease).toBeNull()
    })

    it('claim key expires and subsequent claim succeeds', { skip: skipIfNoRedis, timeout: 5000 }, async () => {
      // arrange
      await store.claim('agentA', 'sess1', { ttlMs: 500 })

      // act
      await new Promise(resolve => setTimeout(resolve, 700))
      const lease = await store.claim('agentA', 'sess1', { ttlMs: 5000 })

      // assert
      expect(lease).not.toBeNull()
    })

  })

  describe('release — lock release and idempotency', () => {

    let client: Redis
    let store: RedisSessionStore

    beforeEach(async () => {
      if (skipIfNoRedis) return
      client = new Redis(process.env.REDIS_URL!)
      store = new RedisSessionStore({ client })
    })

    afterEach(async () => {
      if (skipIfNoRedis) return
      await client.flushdb()
      await client.quit()
    })

    it('removes the claim key; subsequent claim by same store succeeds', { skip: skipIfNoRedis }, async () => {
      // arrange
      const lease = await store.claim('agentA', 'sess1', { ttlMs: 5000 })

      // act
      await store.release(lease!)

      // assert
      const newLease = await store.claim('agentA', 'sess1', { ttlMs: 5000 })
      expect(newLease).not.toBeNull()
    })

    it('resolves without error when claim key is absent (idempotent)', { skip: skipIfNoRedis }, async () => {
      // arrange
      const lease = await store.claim('agentA', 'sess1', { ttlMs: 5000 })
      await store.release(lease!)

      // act — second call on an already-deleted key
      await store.release(lease!)

      // assert — promise resolved without error (no throw)
    })

    it('resolves without error when the Redis client throws during release', async () => {
      // arrange
      const fakeClient = {
        get: vi.fn(),
        set: vi.fn(),
        eval: vi.fn().mockRejectedValue(new Error('connection lost')),
      }
      const errorStore = new RedisSessionStore({ client: fakeClient as unknown as Redis })
      const fakeLease: Lease = {
        agentId: 'agentA',
        sessionId: 'sess1',
        expiresAt: Date.now() + 5000,
        token: { key: 'harness:claims:agentA:sess1', nonce: 'any-nonce' },
      }

      // act
      await errorStore.release(fakeLease)

      // assert — promise resolved without error (no throw)
    })

    it('does not delete the claim when nonce does not match', { skip: skipIfNoRedis }, async () => {
      // arrange
      const leaseA = await store.claim('agentA', 'sess1', { ttlMs: 5000 })
      const leaseB: Lease = {
        agentId: 'agentA',
        sessionId: 'sess1',
        expiresAt: Date.now() + 5000,
        token: {
          key: (leaseA!.token as { key: string; nonce: string }).key,
          nonce: 'stale-nonce-B',
        },
      }

      // act
      await store.release(leaseB)

      // assert
      const reClaim = await store.claim('agentA', 'sess1', { ttlMs: 5000 })
      expect(reClaim).toBeNull()
    })

  })

  describe('extendClaim — TTL extension', () => {

    let client: Redis
    let store: RedisSessionStore

    beforeEach(async () => {
      if (skipIfNoRedis) return
      client = new Redis(process.env.REDIS_URL!)
      store = new RedisSessionStore({ client })
    })

    afterEach(async () => {
      if (skipIfNoRedis) return
      await client.flushdb()
      await client.quit()
    })

    it('returns a new Lease with updated expiresAt and preserved token', { skip: skipIfNoRedis }, async () => {
      // arrange
      const lease = await store.claim('agentA', 'sess1', { ttlMs: 5000 })
      const originalExpiresAt = lease!.expiresAt

      // act
      const newLease = await store.extendClaim(lease!, { ttlMs: 10_000 })

      // assert
      expect(newLease.expiresAt).toBeGreaterThan(originalExpiresAt)
      expect(newLease.expiresAt).toBeLessThanOrEqual(Date.now() + 10_000 + 50)
      expect(newLease.agentId).toBe('agentA')
      expect(newLease.sessionId).toBe('sess1')
      expect(newLease.token).toBe(lease!.token)
    })

    it('throws LeaseNotFoundError when claim key is absent', { skip: skipIfNoRedis }, async () => {
      // arrange
      const lease = await store.claim('agentA', 'sess1', { ttlMs: 5000 })
      await store.release(lease!)

      // act
      const promise = store.extendClaim(lease!, { ttlMs: 5000 })

      // assert
      await expect(promise).rejects.toThrow(LeaseNotFoundError)
      await expect(store.extendClaim(lease!, { ttlMs: 5000 })).rejects.toMatchObject({ sessionId: 'sess1' })
    })

    it('throws LeaseNotFoundError when nonce does not match', { skip: skipIfNoRedis }, async () => {
      // arrange
      await store.claim('agentA', 'sess1', { ttlMs: 5000 })
      const staleToken = { key: 'harness:claims:agentA:sess1', nonce: 'old-nonce-B' }
      const leaseB: Lease = {
        agentId: 'agentA',
        sessionId: 'sess1',
        expiresAt: Date.now() + 5000,
        token: staleToken,
      }

      // act
      const promise = store.extendClaim(leaseB, { ttlMs: 5000 })

      // assert
      await expect(promise).rejects.toThrow(LeaseNotFoundError)
      await expect(store.extendClaim(leaseB, { ttlMs: 5000 })).rejects.toMatchObject({ sessionId: 'sess1' })
    })

  })

  describe('cross-instance scenarios', () => {

    let client: Redis

    beforeEach(async () => {
      if (skipIfNoRedis) return
      client = new Redis(process.env.REDIS_URL!)
    })

    afterEach(async () => {
      if (skipIfNoRedis) return
      await client.flushdb()
      await client.quit()
    })

    it('second store instance reads data saved by first', { skip: skipIfNoRedis }, async () => {
      // arrange
      const storeA = new RedisSessionStore({ client })
      const storeB = new RedisSessionStore({ client })
      const run1 = makeRun({ version: 0, phase: 'completed', finalState: { result: 42 } })
      await storeA.save('agentA', 'sess1', run1)

      // act
      const loaded = await storeB.load('agentA', 'sess1')

      // assert
      expect(loaded).toEqual(run1)
    })

    it("second writer's save throws ConcurrentModificationError when first already wrote", { skip: skipIfNoRedis }, async () => {
      // arrange
      const storeA = new RedisSessionStore({ client })
      const storeB = new RedisSessionStore({ client })
      const run0 = makeRun({ version: 0, phase: 'paused', finalState: {} })
      await storeA.save('agentA', 'sess1', run0)

      const runA1 = makeRun({ runId: 'run-A1', version: 1, phase: 'completed', finalState: { winner: 'A' } })
      const runB1 = makeRun({ runId: 'run-B1', version: 1, phase: 'completed', finalState: { winner: 'B' } })
      await storeA.save('agentA', 'sess1', runA1)

      // act
      const promise = storeB.save('agentA', 'sess1', runB1)

      // assert
      await expect(promise).rejects.toThrow(ConcurrentModificationError)
      const loaded = await storeA.load('agentA', 'sess1')
      expect(loaded).toEqual(runA1)
    })

  })

})
