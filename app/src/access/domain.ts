import { isSignedIn } from '@/access/roles'

import type { Access, FieldAccess, Where } from 'payload'

/** Billed time is locked; only unbilled time can be edited or deleted. */
export const unbilledTimeOnly: Access = ({ req }) => {
  if (!isSignedIn(req.user)) return false
  const unbilled: Where = { billingStatus: { equals: 'unbilled' } }
  return unbilled
}

export const authenticatedField: FieldAccess = ({ req }) => isSignedIn(req.user)

export const systemFieldWrite: FieldAccess = () => false
