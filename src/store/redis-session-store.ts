import type { Redis } from 'ioredis'
import type { SessionStore, StoredRun, ClaimOptions, Lease } from '@noetaris/harness'
import { randomUUID } from 'node:crypto'
import { ConcurrentModificationError } from '../errors.js'
import { LeaseNotFoundError } from '../errors.js'

/** Options for {@link RedisSessionStore}. */
export interface RedisSessionStoreOptions {
  /**
   * A pre-constructed ioredis `Redis` instance.
   * The store does not create or manage the connection lifecycle — the caller
   * is responsible for connecting before use and disconnecting after.
   */
  readonly client: Redis

  /**
   * Optional key prefix prepended to all Redis keys, separated by a colon.
   * Useful when multiple agents or environments share one Redis instance.
   *
   * Default: `"harness"`.
   *
   * Example: `{ prefix: "myapp" }` → run key becomes `myapp:runs:{agentId}:{sessionId}`.
   */
  readonly prefix?: string
}

// Stored at the run key: `{prefix}:runs:{agentId}:{sessionId}`
type RunEnvelope = {
  version: number
  run: StoredRun
}

// Stored at the claim key: `{prefix}:claims:{agentId}:{sessionId}`
type ClaimRecord = {
  nonce: string
  agentId: string
  sessionId: string
  instanceId?: string
  expiresAt: number
}

// Conditionally writes run envelope only if stored version equals (run.version - 1)
// or the key does not exist and run.version === 0.
// Returns 1 on success, 0 on version mismatch.
const SAVE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  local envelope = cjson.decode(current)
  if envelope.version ~= tonumber(ARGV[1]) - 1 then
    return 0
  end
else
  if tonumber(ARGV[1]) ~= 0 then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`

// Deletes the claim key only if the stored nonce matches.
// Returns 1 if deleted, 0 if not found or nonce mismatch.
const RELEASE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 0
end
local record = cjson.decode(current)
if record.nonce ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
return 1
`

// Extends the TTL of the claim key only if the stored nonce matches.
// Returns the new expiresAt (milliseconds) on success, 0 if not found or mismatch.
const EXTEND_CLAIM_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  return 0
end
local record = cjson.decode(current)
if record.nonce ~= ARGV[1] then
  return 0
end
local ttlMs = tonumber(ARGV[2])
local newExpiresAt = tonumber(ARGV[3])
record.expiresAt = newExpiresAt
redis.call('SET', KEYS[1], cjson.encode(record), 'PX', ttlMs)
return newExpiresAt
`

/**
 * Redis-backed {@link SessionStore} providing durable cross-process session
 * persistence, atomic conditional save (optimistic locking via Lua), and
 * distributed claim/lease management.
 *
 * @example
 * ```ts
 * import Redis from 'ioredis'
 * const client = new Redis(process.env.REDIS_URL)
 * const store = new RedisSessionStore({ client })
 * ```
 */
export class RedisSessionStore implements SessionStore {
  private readonly client: Redis
  private readonly prefix: string

  constructor(options: RedisSessionStoreOptions) {
    this.client = options.client
    // normalize empty string to default prefix
    this.prefix =
      options.prefix !== undefined && options.prefix.length > 0 ? options.prefix : 'harness'
  }

  private runKey(agentId: string, sessionId: string): string {
    return `${this.prefix}:runs:${agentId}:${sessionId}`
  }

  private claimKey(agentId: string, sessionId: string): string {
    return `${this.prefix}:claims:${agentId}:${sessionId}`
  }

  async load(agentId: string, sessionId: string): Promise<StoredRun | null> {
    const value = await this.client.get(this.runKey(agentId, sessionId))
    if (value === null) return null
    const envelope = JSON.parse(value) as RunEnvelope // as: JSON.parse returns unknown; Redis stores only RunEnvelope values written by save()
    return envelope.run
  }

  async save(agentId: string, sessionId: string, run: StoredRun): Promise<void> {
    const key = this.runKey(agentId, sessionId)
    const envelope: RunEnvelope = { version: run.version, run }
    const result = await this.client.eval(
      SAVE_SCRIPT,
      1,
      key,
      String(run.version),
      JSON.stringify(envelope),
    ) as number // as: ioredis types eval result as unknown; Lua script returns a number

    if (result === 0) {
      throw new ConcurrentModificationError(sessionId, run.version, run.version - 1)
    }
  }

  async claim(agentId: string, sessionId: string, options: ClaimOptions): Promise<Lease | null> {
    const nonce = randomUUID()
    const expiresAt = Date.now() + options.ttlMs
    const key = this.claimKey(agentId, sessionId)

    const record: ClaimRecord = { nonce, agentId, sessionId, expiresAt }
    const result = await this.client.set(key, JSON.stringify(record), 'PX', options.ttlMs, 'NX')

    if (result === null) return null

    return {
      expiresAt,
      agentId,
      sessionId,
      token: { key, nonce },
    }
  }

  async release(lease: Lease): Promise<void> {
    try {
      const { key, nonce } = lease.token as { key: string; nonce: string } // as: RedisSessionStore sets Lease.token to { key, nonce }; framework types it unknown
      await this.client.eval(RELEASE_SCRIPT, 1, key, nonce)
    } catch {
      // release is called from finally blocks; swallow all errors to avoid unhandled rejections
    }
  }

  async extendClaim(lease: Lease, options: ClaimOptions): Promise<Lease> {
    const newExpiresAt = Date.now() + options.ttlMs
    const { key, nonce } = lease.token as { key: string; nonce: string } // as: RedisSessionStore sets Lease.token to { key, nonce }; framework types it unknown

    const result = await this.client.eval(
      EXTEND_CLAIM_SCRIPT,
      1,
      key,
      nonce,
      String(options.ttlMs),
      String(newExpiresAt),
    ) as number // as: ioredis types eval result as unknown; Lua script returns a number

    if (result === 0) {
      throw new LeaseNotFoundError(lease.sessionId)
    }

    return {
      expiresAt: newExpiresAt,
      agentId: lease.agentId,
      sessionId: lease.sessionId,
      token: lease.token,
      ...(lease.instanceId !== undefined ? { instanceId: lease.instanceId } : {}),
    }
  }

  // loadHistory and branch are intentionally not implemented.
  // Redis stores only the latest run — history is not supported.
}
