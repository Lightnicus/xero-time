import { describe, expect, it, vi } from 'vitest'

import {
  isDuplicateMongoKeyError,
  withDeploymentMigrationLease,
  type DeploymentMigrationLeaseStore,
} from '@/lib/deployment/migration-lock'

const leaseStore = (overrides: Partial<DeploymentMigrationLeaseStore> = {}) =>
  ({
    ensureExpiryIndex: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(undefined),
    tryAcquire: vi.fn().mockResolvedValue(true),
    ...overrides,
  }) satisfies DeploymentMigrationLeaseStore

describe('production deployment migration lease', () => {
  it('recognizes only MongoDB duplicate-key failures as lock contention', () => {
    expect(isDuplicateMongoKeyError({ code: 11_000 })).toBe(true)
    expect(isDuplicateMongoKeyError({ code: 12_000 })).toBe(false)
    expect(isDuplicateMongoKeyError(new Error('unavailable'))).toBe(false)
  })

  it('holds and releases the lease around migration work', async () => {
    const store = leaseStore()
    const work = vi.fn().mockResolvedValue('complete')

    await expect(
      withDeploymentMigrationLease(
        store,
        {
          heartbeatMilliseconds: 0,
          leaseMilliseconds: 1_000,
          now: () => new Date(10_000),
          owner: 'deployment-1',
        },
        work,
      ),
    ).resolves.toBe('complete')

    expect(store.ensureExpiryIndex).toHaveBeenCalledOnce()
    expect(store.tryAcquire).toHaveBeenCalledWith(
      'deployment-1',
      new Date(10_000),
      new Date(11_000),
    )
    expect(work).toHaveBeenCalledOnce()
    expect(store.release).toHaveBeenCalledWith('deployment-1')
  })

  it('waits for an existing deployment and then acquires the lease', async () => {
    let time = 0
    const tryAcquire = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const store = leaseStore({ tryAcquire })

    await withDeploymentMigrationLease(
      store,
      {
        heartbeatMilliseconds: 0,
        now: () => new Date(time),
        owner: 'deployment-2',
        pollMilliseconds: 25,
        sleep: async (milliseconds) => {
          time += milliseconds
        },
        waitMilliseconds: 100,
      },
      async () => undefined,
    )

    expect(tryAcquire).toHaveBeenCalledTimes(2)
    expect(store.release).toHaveBeenCalledWith('deployment-2')
  })

  it('times out without running or releasing work it never acquired', async () => {
    let time = 0
    const store = leaseStore({ tryAcquire: vi.fn().mockResolvedValue(false) })
    const work = vi.fn()

    await expect(
      withDeploymentMigrationLease(
        store,
        {
          heartbeatMilliseconds: 0,
          now: () => new Date(time),
          owner: 'deployment-3',
          pollMilliseconds: 10,
          sleep: async (milliseconds) => {
            time += milliseconds
          },
          waitMilliseconds: 20,
        },
        work,
      ),
    ).rejects.toThrow(/Timed out waiting/)

    expect(work).not.toHaveBeenCalled()
    expect(store.release).not.toHaveBeenCalled()
  })

  it('releases the lease when migration work fails', async () => {
    const store = leaseStore()

    await expect(
      withDeploymentMigrationLease(
        store,
        { heartbeatMilliseconds: 0, owner: 'deployment-4' },
        async () => {
          throw new Error('migration failed')
        },
      ),
    ).rejects.toThrow('migration failed')

    expect(store.release).toHaveBeenCalledWith('deployment-4')
  })
})
