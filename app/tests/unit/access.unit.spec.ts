import { describe, expect, it } from 'vitest'

import { unbilledTimeOnly } from '@/access/domain'
import { authenticated, isSignedIn, signedInAdmin } from '@/access/roles'

const req = (user: unknown) => ({ req: { user } }) as never

describe('single-user access', () => {
  it('treats any signed-in user as allowed and anonymous requests as denied', () => {
    const user = { collection: 'users', id: 'user-1' }
    expect(isSignedIn(user)).toBe(true)
    expect(authenticated(req(user))).toBe(true)
    expect(signedInAdmin(req(user) as { req: { user: unknown } })).toBe(true)

    for (const anonymous of [null, undefined, {}, { collection: 'users' }, { id: 'x' }]) {
      expect(isSignedIn(anonymous)).toBe(false)
      expect(authenticated(req(anonymous))).toBe(false)
    }
    expect(isSignedIn({ collection: 'payload-mcp-api-keys', id: 'key-1' })).toBe(false)
  })

  it('only lets unbilled time be changed', () => {
    expect(unbilledTimeOnly(req({ collection: 'users', id: 'user-1' }))).toEqual({
      billingStatus: { equals: 'unbilled' },
    })
    expect(unbilledTimeOnly(req(null))).toBe(false)
  })
})
