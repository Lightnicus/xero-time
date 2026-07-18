import type { Access } from 'payload'

export const USER_ROLES = ['owner', 'admin', 'biller', 'member'] as const

export type UserRole = (typeof USER_ROLES)[number]

/**
 * The small, stable user shape authorization code is allowed to trust.
 * Keeping this independent from generated Payload types lets access checks fail
 * closed while the schema and generated types are updated in separate steps.
 */
export type AccessUser = {
  active?: unknown
  collection?: unknown
  id?: unknown
  role?: unknown
}

export type ActiveAccessUser = {
  active: true
  collection: 'users'
  id: number | string
  role: UserRole
}

export const isUserRole = (value: unknown): value is UserRole =>
  typeof value === 'string' && USER_ROLES.some((role) => role === value)

const isDocumentID = (value: unknown): value is number | string =>
  (typeof value === 'number' && Number.isFinite(value)) ||
  (typeof value === 'string' && value.length > 0)

/** Unknown roles, inactive users, and non-user auth principals are denied. */
export const isActiveUser = (user: unknown): user is ActiveAccessUser => {
  if (!user || typeof user !== 'object') return false

  const candidate = user as AccessUser

  return (
    candidate.collection === 'users' &&
    candidate.active === true &&
    isDocumentID(candidate.id) &&
    isUserRole(candidate.role)
  )
}

export const hasActiveRole = (
  user: unknown,
  allowedRoles: readonly UserRole[],
): user is ActiveAccessUser => isActiveUser(user) && allowedRoles.includes(user.role)

export const isActiveOwner = (user: unknown): user is ActiveAccessUser =>
  hasActiveRole(user, ['owner'])

export const isActiveOwnerOrAdmin = (user: unknown): user is ActiveAccessUser =>
  hasActiveRole(user, ['owner', 'admin'])

export const authenticated: Access = ({ req }) => isActiveUser(req.user)

export const ownerOnly: Access = ({ req }) => isActiveOwner(req.user)

export const ownerOrAdmin: Access = ({ req }) => isActiveOwnerOrAdmin(req.user)

export const ownerAdminOrBiller: Access = ({ req }) =>
  hasActiveRole(req.user, ['owner', 'admin', 'biller'])
