import { hasActiveRole, isActiveOwnerOrAdmin, isActiveUser } from '@/access/roles'

import type { Access, FieldAccess, PayloadRequest, Where } from 'payload'

type AdminAccess = ({ req }: { req: PayloadRequest }) => boolean | Promise<boolean>

export const adminOnly: AdminAccess = ({ req }) => isActiveOwnerOrAdmin(req.user)

export const readBusinessDirectory: Access = ({ req }) => {
  if (hasActiveRole(req.user, ['owner', 'admin', 'biller'])) return true
  if (hasActiveRole(req.user, ['member'])) return { status: { equals: 'active' } }
  return false
}

export const createTimeEntry: Access = ({ req }) =>
  hasActiveRole(req.user, ['owner', 'admin', 'member'])

export const readTimeEntries: Access = ({ req }) => {
  if (hasActiveRole(req.user, ['owner', 'admin', 'biller'])) return true
  if (hasActiveRole(req.user, ['member'])) {
    const userID = req.user.id

    return { owner: { equals: userID } }
  }
  return false
}

export const updateOwnUnbilledTime: Access = ({ req }) => {
  if (isActiveOwnerOrAdmin(req.user)) {
    const ownerAdminFilter: Where = { billingStatus: { equals: 'unbilled' } }

    return ownerAdminFilter
  }
  if (hasActiveRole(req.user, ['member'])) {
    const userID = req.user.id
    const memberFilter: Where = {
      and: [{ owner: { equals: userID } }, { billingStatus: { equals: 'unbilled' } }],
    }

    return memberFilter
  }
  return false
}

/** Owners/admins use the audited privileged-delete command; members may delete only their own time. */
export const deleteOwnUnbilledTime: Access = ({ req }) => {
  if (hasActiveRole(req.user, ['member'])) {
    const memberDeleteFilter: Where = {
      and: [{ owner: { equals: req.user.id } }, { billingStatus: { equals: 'unbilled' } }],
    }
    return memberDeleteFilter
  }
  return false
}

export const authenticatedField: FieldAccess = ({ req }) => isActiveUser(req.user)

export const financialField: FieldAccess = ({ req }) =>
  hasActiveRole(req.user, ['owner', 'admin', 'biller'])

export const ownerAdminField: FieldAccess = ({ req }) => isActiveOwnerOrAdmin(req.user)

export const systemFieldWrite: FieldAccess = () => false
