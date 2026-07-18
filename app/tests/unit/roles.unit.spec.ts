import { describe, expect, it } from 'vitest'

import {
  USER_ROLES,
  hasActiveRole,
  isActiveOwner,
  isActiveOwnerOrAdmin,
  isActiveUser,
  isUserRole,
} from '@/access/roles'

const user = (role: string, active = true) => ({
  active,
  collection: 'users',
  id: `${role}-id`,
  role,
})

describe('role authorization', () => {
  it('keeps the role list explicit', () => {
    expect(USER_ROLES).toEqual(['owner', 'admin', 'biller', 'member'])
    expect(USER_ROLES.every(isUserRole)).toBe(true)
  })

  it.each(['unknown', '', null, undefined, 1])('rejects unknown role %s', (role) => {
    expect(isUserRole(role)).toBe(false)
  })

  it('accepts only active users from the local users collection', () => {
    expect(isActiveUser(user('member'))).toBe(true)
    expect(isActiveUser(user('member', false))).toBe(false)
    expect(isActiveUser({ ...user('member'), collection: 'another-collection' })).toBe(false)
    expect(isActiveUser(user('unknown'))).toBe(false)
    expect(isActiveUser(null)).toBe(false)
  })

  it('checks privileged roles without treating billers as administrators', () => {
    expect(isActiveOwner(user('owner'))).toBe(true)
    expect(isActiveOwnerOrAdmin(user('admin'))).toBe(true)
    expect(isActiveOwnerOrAdmin(user('biller'))).toBe(false)
    expect(hasActiveRole(user('biller'), ['owner', 'admin', 'biller'])).toBe(true)
    expect(hasActiveRole(user('member'), ['owner', 'admin', 'biller'])).toBe(false)
  })
})
