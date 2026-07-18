import { Forbidden } from 'payload'

import {
  USER_ROLES,
  hasActiveRole,
  isActiveOwner,
  isActiveOwnerOrAdmin,
  isActiveUser,
  isUserRole,
} from './roles'
import { ACCOUNT_INVITATION_ACCEPTANCE_CONTEXT } from '../lib/account-lifecycle/context'

import type { Access, CollectionBeforeValidateHook, FieldAccess, PayloadRequest } from 'payload'

const ADMIN_MANAGED_ROLES = ['biller', 'member'] as const
const OWNER_MANAGED_ROLES = ['admin', 'biller', 'member'] as const

/** Server-only context flag used by the controlled initial-owner seed. */
export const INITIAL_OWNER_SEED_CONTEXT = 'allowInitialOwnerSeed'
export const INITIAL_OWNER_BOOTSTRAP_MARKER = 'initial-owner'
const INITIAL_OWNER_LOCK_COLLECTION = 'application_bootstrap_locks'

const sameID = (left: unknown, right: unknown): boolean =>
  (typeof left === 'number' || typeof left === 'string') &&
  (typeof right === 'number' || typeof right === 'string') &&
  String(left) === String(right)

const ownDocument = (id: number | string) => ({
  id: {
    equals: id,
  },
})

const roleIsOneOf = (roles: readonly string[]) => ({
  role: {
    in: roles,
  },
})

const isDuplicateKeyError = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 11_000,
  )

/**
 * Uses MongoDB's always-unique `_id` inside the same transaction as user creation.
 * This remains atomic even before application-defined indexes are provisioned.
 */
const acquireInitialOwnerLock = async (req: PayloadRequest): Promise<void> => {
  const database = req.payload.db.connection.db
  if (!database) throw new Error('MongoDB is unavailable for initial-owner bootstrap.')

  const transactionID = await req.transactionID
  const session = transactionID ? req.payload.db.sessions[transactionID] : undefined

  try {
    await database
      .collection<{ _id: string; createdAt: Date }>(INITIAL_OWNER_LOCK_COLLECTION)
      .insertOne(
        {
          _id: INITIAL_OWNER_BOOTSTRAP_MARKER,
          createdAt: new Date(),
        },
        { session },
      )
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new Forbidden(req.t)
    throw error
  }
}

export const canAccessPayloadAdmin = ({ req }: { req: PayloadRequest }): boolean =>
  isActiveOwnerOrAdmin(req.user)

export const canCreateUsers: Access = ({ req }) => isActiveOwnerOrAdmin(req.user)

export const canReadUsers: Access = ({ req }) => {
  if (isActiveOwnerOrAdmin(req.user)) return true
  if (!isActiveUser(req.user)) return false

  return ownDocument(req.user.id)
}

export const canUpdateUsers: Access = ({ req }) => {
  if (!isActiveUser(req.user)) return false

  if (req.user.role === 'owner') {
    return {
      or: [ownDocument(req.user.id), roleIsOneOf(OWNER_MANAGED_ROLES)],
    }
  }

  if (req.user.role === 'admin') {
    return {
      or: [ownDocument(req.user.id), roleIsOneOf(ADMIN_MANAGED_ROLES)],
    }
  }

  return ownDocument(req.user.id)
}

export const canDeleteUsers: Access = ({ req }) => {
  if (!isActiveUser(req.user)) return false

  const managedRoles =
    req.user.role === 'owner'
      ? OWNER_MANAGED_ROLES
      : req.user.role === 'admin'
        ? ADMIN_MANAGED_ROLES
        : null

  if (!managedRoles) return false

  return {
    and: [
      roleIsOneOf(managedRoles),
      {
        id: {
          not_equals: req.user.id,
        },
      },
    ],
  }
}

export const canUnlockUsers: Access = ({ req }) => {
  if (isActiveOwner(req.user)) return roleIsOneOf(USER_ROLES)
  if (hasActiveRole(req.user, ['admin'])) return roleIsOneOf(ADMIN_MANAGED_ROLES)

  return false
}

/**
 * Only owners may assign roles. Existing owner records are intentionally not
 * mutable through generic CRUD; demoting an owner belongs in a separately
 * audited command that can protect the final active owner transactionally.
 */
export const canSetUserRole: FieldAccess = ({ doc, id, req }) => {
  if (!isActiveOwner(req.user)) return false
  if (typeof id === 'undefined') return true
  if (sameID(req.user.id, id)) return false

  const targetRole = doc && typeof doc === 'object' ? (doc as { role?: unknown }).role : undefined

  return isUserRole(targetRole) && targetRole !== 'owner'
}

/** Admins may suspend regular accounts; owners may also suspend admins. */
export const canSetUserActiveState: FieldAccess = ({ doc, id, req }) => {
  if (!isActiveOwnerOrAdmin(req.user)) return false
  if (typeof id === 'undefined') return true
  if (sameID(req.user.id, id)) return false

  const targetRole = doc && typeof doc === 'object' ? (doc as { role?: unknown }).role : undefined

  if (!isUserRole(targetRole) || targetRole === 'owner') return false

  return req.user.role === 'owner' || targetRole === 'biller' || targetRole === 'member'
}

/**
 * Payload's register-first-user operation independently verifies that the
 * collection is empty and bypasses collection access. This second check makes
 * that one anonymous bootstrap deterministic and rejects later anonymous or
 * insufficiently privileged Local API creates as well.
 */
export const bootstrapFirstOwner: CollectionBeforeValidateHook = async ({
  data,
  operation,
  req,
}) => {
  if (operation !== 'create') return data
  if (isActiveOwnerOrAdmin(req.user)) return data

  if (req.context?.[ACCOUNT_INVITATION_ACCEPTANCE_CONTEXT] === true) {
    const existingUser = await req.payload.db.findOne({
      collection: 'users',
      req,
      where: {},
    })
    if (!existingUser) throw new Forbidden(req.t)
    return data
  }

  if (req.user) throw new Forbidden(req.t)

  const existingUser = await req.payload.db.findOne({
    collection: 'users',
    req,
    where: {},
  })

  if (existingUser) throw new Forbidden(req.t)

  await acquireInitialOwnerLock(req)

  return {
    ...data,
    _verified: true,
    active: true,
    bootstrapMarker: INITIAL_OWNER_BOOTSTRAP_MARKER,
    role: 'owner',
  }
}
