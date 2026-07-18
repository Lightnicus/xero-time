import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  INITIAL_OWNER_BOOTSTRAP_MARKER,
  INITIAL_OWNER_SEED_CONTEXT,
  bootstrapFirstOwner,
} from '@/access/users'
import { enforcePasswordPolicy } from '@/collections/Users'

const firstOwnerData = {
  active: false,
  displayName: 'First Owner',
  email: 'first-owner@example.test',
  password: 'test-password-only',
  role: 'member',
  timezone: 'Pacific/Auckland',
}

const runBootstrap = (
  context: Record<string, unknown> = {},
  insertOne = vi.fn().mockResolvedValue({ acknowledged: true }),
) =>
  bootstrapFirstOwner({
    collection: {} as never,
    context,
    data: firstOwnerData,
    operation: 'create',
    originalDoc: undefined,
    req: {
      context,
      payload: {
        db: {
          connection: {
            db: {
              collection: vi.fn().mockReturnValue({
                insertOne,
              }),
            },
          },
          findOne: vi.fn().mockResolvedValue(null),
          sessions: {},
        },
      },
      user: null,
    } as never,
  })

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('initial-owner bootstrap', () => {
  it('allows the one-time first-user operation in production and stamps its marker', async () => {
    vi.stubEnv('NODE_ENV', 'production')

    await expect(runBootstrap()).resolves.toMatchObject({
      active: true,
      bootstrapMarker: INITIAL_OWNER_BOOTSTRAP_MARKER,
      role: 'owner',
    })
  })

  it('applies the same production bootstrap invariant to the controlled seed', async () => {
    vi.stubEnv('NODE_ENV', 'production')

    await expect(runBootstrap({ [INITIAL_OWNER_SEED_CONTEXT]: true })).resolves.toMatchObject({
      active: true,
      bootstrapMarker: INITIAL_OWNER_BOOTSTRAP_MARKER,
      role: 'owner',
    })
  })

  it('retains Payload first-user convenience outside production', async () => {
    vi.stubEnv('NODE_ENV', 'test')

    await expect(runBootstrap()).resolves.toMatchObject({
      active: true,
      bootstrapMarker: INITIAL_OWNER_BOOTSTRAP_MARKER,
      role: 'owner',
    })
  })

  it('rejects a concurrent bootstrap when the atomic lock already exists', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    const duplicateLock = vi.fn().mockRejectedValue({ code: 11_000 })

    await expect(runBootstrap({}, duplicateLock)).rejects.toMatchObject({ status: 403 })
  })
})

describe('user password policy', () => {
  it('rejects seven characters and accepts the eight-character boundary', () => {
    expect(() =>
      enforcePasswordPolicy({
        args: { data: { password: 'short7!' } },
        operation: 'resetPassword',
        req: {} as never,
      } as never),
    ).toThrow('password')

    expect(() =>
      enforcePasswordPolicy({
        args: { data: { password: 'eight888' } },
        operation: 'resetPassword',
        req: {} as never,
      } as never),
    ).not.toThrow()
  })
})
