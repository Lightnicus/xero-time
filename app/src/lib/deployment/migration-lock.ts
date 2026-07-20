import type { Payload } from 'payload'

const LOCK_COLLECTION = 'application_deployment_locks'
const LOCK_ID = 'payload-production-migrations'

const DEFAULT_HEARTBEAT_MILLISECONDS = 30_000
const DEFAULT_LEASE_MILLISECONDS = 5 * 60_000
const DEFAULT_POLL_MILLISECONDS = 2_000
const DEFAULT_WAIT_MILLISECONDS = 10 * 60_000

type MongoDatabase = NonNullable<Payload['db']['connection']['db']>

type DeploymentMigrationLockDocument = {
  _id: string
  acquiredAt: Date
  expiresAt: Date
  owner: string
  updatedAt: Date
}

export type DeploymentMigrationLeaseStore = {
  ensureExpiryIndex: () => Promise<void>
  refresh: (owner: string, now: Date, expiresAt: Date) => Promise<boolean>
  release: (owner: string) => Promise<void>
  tryAcquire: (owner: string, now: Date, expiresAt: Date) => Promise<boolean>
}

type DeploymentMigrationLeaseOptions = {
  heartbeatMilliseconds?: number
  leaseMilliseconds?: number
  now?: () => Date
  owner: string
  pollMilliseconds?: number
  sleep?: (milliseconds: number) => Promise<void>
  waitMilliseconds?: number
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

export const isDuplicateMongoKeyError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 11_000

export const mongoDeploymentMigrationLeaseStore = (
  database: MongoDatabase,
): DeploymentMigrationLeaseStore => {
  const collection = database.collection<DeploymentMigrationLockDocument>(LOCK_COLLECTION)

  return {
    ensureExpiryIndex: async () => {
      await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'expiresAt_1' })
    },
    refresh: async (owner, now, expiresAt) => {
      const result = await collection.updateOne(
        { _id: LOCK_ID, owner },
        { $set: { expiresAt, updatedAt: now } },
      )
      return result.matchedCount === 1
    },
    release: async (owner) => {
      await collection.deleteOne({ _id: LOCK_ID, owner })
    },
    tryAcquire: async (owner, now, expiresAt) => {
      try {
        const result = await collection.updateOne(
          {
            _id: LOCK_ID,
            $or: [{ expiresAt: { $lte: now } }, { owner }],
          },
          {
            $set: { acquiredAt: now, expiresAt, owner, updatedAt: now },
          },
          { upsert: true },
        )
        return result.matchedCount === 1 || result.upsertedCount === 1
      } catch (error) {
        if (isDuplicateMongoKeyError(error)) return false
        throw error
      }
    },
  }
}

export const withDeploymentMigrationLease = async <Result>(
  store: DeploymentMigrationLeaseStore,
  options: DeploymentMigrationLeaseOptions,
  work: () => Promise<Result>,
): Promise<Result> => {
  const heartbeatMilliseconds = options.heartbeatMilliseconds ?? DEFAULT_HEARTBEAT_MILLISECONDS
  const leaseMilliseconds = options.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS
  const now = options.now ?? (() => new Date())
  const pollMilliseconds = options.pollMilliseconds ?? DEFAULT_POLL_MILLISECONDS
  const waitMilliseconds = options.waitMilliseconds ?? DEFAULT_WAIT_MILLISECONDS
  const wait = options.sleep ?? sleep

  await store.ensureExpiryIndex()
  const deadline = now().getTime() + waitMilliseconds
  while (true) {
    const attemptedAt = now()
    const acquired = await store.tryAcquire(
      options.owner,
      attemptedAt,
      new Date(attemptedAt.getTime() + leaseMilliseconds),
    )
    if (acquired) break
    if (attemptedAt.getTime() >= deadline) {
      throw new Error('Timed out waiting for the production migration lease.')
    }
    await wait(pollMilliseconds)
  }

  let heartbeatError: unknown
  let refreshChain = Promise.resolve()
  const heartbeat =
    heartbeatMilliseconds > 0
      ? setInterval(() => {
          refreshChain = refreshChain
            .then(async () => {
              if (heartbeatError) return
              const refreshedAt = now()
              const refreshed = await store.refresh(
                options.owner,
                refreshedAt,
                new Date(refreshedAt.getTime() + leaseMilliseconds),
              )
              if (!refreshed) throw new Error('The production migration lease was lost.')
            })
            .catch((error: unknown) => {
              heartbeatError = error
            })
        }, heartbeatMilliseconds)
      : undefined

  try {
    const result = await work()
    await refreshChain
    if (heartbeatError) throw heartbeatError
    return result
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    await refreshChain
    await store.release(options.owner)
  }
}
