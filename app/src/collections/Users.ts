import { decodeJwt } from 'jose'
import { AuthenticationError, ValidationError } from 'payload'

import { isActiveOwnerOrAdmin, USER_ROLES } from '../access/roles'
import {
  bootstrapFirstOwner,
  canAccessPayloadAdmin,
  canCreateUsers,
  canDeleteUsers,
  canReadUsers,
  canSetUserActiveState,
  canSetUserRole,
  canUnlockUsers,
  canUpdateUsers,
} from '../access/users'
import { canDeliverAccountEmail } from '../lib/account-email'
import { OWNER_TRANSITION_CONTEXT } from '../lib/account-lifecycle/context'
import { MIN_PASSWORD_LENGTH } from '../lib/account-lifecycle/password-policy'
import { isRecord, validateIanaTimezone } from '../lib/domain/validation'
import { environment } from '../lib/env'
import {
  expiredExternalSessionCookieHeader,
  readExternalSessionCookie,
  xeroExternalSessionStrategy,
} from '../lib/xero/identity/strategy'

import type {
  CollectionAfterOperationHook,
  CollectionAfterChangeHook,
  CollectionAfterLogoutHook,
  CollectionAfterReadHook,
  CollectionBeforeChangeHook,
  CollectionBeforeLoginHook,
  CollectionBeforeOperationHook,
  CollectionConfig,
  CollectionRefreshHook,
} from 'payload'

const rejectInactiveLogin: CollectionBeforeLoginHook = ({ req, user }) => {
  if (!user || typeof user !== 'object' || user.active !== true) {
    // Deliberately use the same response as invalid credentials.
    throw new AuthenticationError(req.t)
  }
}

const rejectInactiveRefresh: CollectionRefreshHook = ({ args, user }) => {
  if (!user || typeof user !== 'object' || user.active !== true) {
    throw new AuthenticationError(args.req.t)
  }
}

const revokeSessionsWhenDeactivated: CollectionBeforeChangeHook = ({ data, operation }) => {
  if (operation !== 'update' || data.active !== false) return data

  return {
    ...data,
    resetPasswordExpiration: null,
    resetPasswordToken: null,
    sessions: [],
  }
}

const normalizedEmail = (value: unknown): null | string =>
  typeof value === 'string' ? value.trim().toLowerCase() : null

/**
 * Payload's generic REST/GraphQL update accepts `password` and `email` on the caller's own
 * record with no current-password check, session revocation, or re-verification. The app's
 * own flows (password change, reset, invitation acceptance, seeding) use the Local API, so
 * only external API requests by the account holder are rejected here. Owners and admins
 * editing other accounts through Payload Admin are unaffected.
 */
export const rejectGenericOwnCredentialChanges: CollectionBeforeChangeHook = ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (operation !== 'update' || req.payloadAPI === 'local') return data
  if (!req.user || !originalDoc || String(req.user.id) !== String(originalDoc.id)) return data

  const errors: Array<{ message: string; path: string }> = []
  // Matches Payload's own test for whether an update saves a new password.
  if (data.password) {
    errors.push({
      message: 'Change your password from your profile page.',
      path: 'password',
    })
  }
  if (
    data.email !== undefined &&
    normalizedEmail(data.email) !== normalizedEmail(originalDoc.email)
  ) {
    errors.push({
      message: 'Your own email address cannot be changed here.',
      path: 'email',
    })
  }
  if (errors.length > 0) throw new ValidationError({ collection: 'users', errors, req })
  return data
}

const PASSWORD_CHANGED_CONTEXT = 'usersPasswordChangedIDs'

const passwordChangedIDs = (context: unknown): string[] => {
  const value = isRecord(context) ? context[PASSWORD_CHANGED_CONTEXT] : undefined
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

/** Any password change through an update ends every Payload session for that account. */
const revokeSessionsWhenPasswordChanges: CollectionBeforeChangeHook = ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (operation !== 'update' || !data.password || !originalDoc) return data
  req.context = {
    ...req.context,
    [PASSWORD_CHANGED_CONTEXT]: [...passwordChangedIDs(req.context), String(originalDoc.id)],
  }
  return { ...data, sessions: [] }
}

const revokeExternalSessionsAfterPasswordChange: CollectionAfterChangeHook = async ({
  doc,
  operation,
  req,
}) => {
  if (operation !== 'update') return doc
  const changed = passwordChangedIDs(req.context)
  if (!changed.includes(String(doc.id))) return doc
  req.context[PASSWORD_CHANGED_CONTEXT] = changed.filter((id) => id !== String(doc.id))
  const { revokeAllExternalSessionsForUser } = await import('@/lib/xero/identity/service')
  await revokeAllExternalSessionsForUser(req.payload, doc.id, 'password-changed', req)
  return doc
}

/**
 * Payload's logout (used by Payload Admin) removes only the JWT session, while the Xero
 * session strategy authenticates first from its own cookie. End that session as well and
 * expire its cookie on the REST response; the app's own logout action already does both.
 */
const revokeExternalSessionOnLogout: CollectionAfterLogoutHook = async ({ req }) => {
  const rawToken = readExternalSessionCookie(req.headers)
  if (!rawToken) return
  const { revokeCurrentExternalSession } = await import('@/lib/xero/identity/service')
  await revokeCurrentExternalSession(req.payload, rawToken, req)
  const responseHeaders = req.responseHeaders ?? new Headers()
  responseHeaders.append('Set-Cookie', expiredExternalSessionCookieHeader())
  req.responseHeaders = responseHeaders
}

const revokeExternalSessionsWhenDeactivated: CollectionAfterChangeHook = async ({
  doc,
  operation,
  previousDoc,
  req,
}) => {
  if (operation !== 'update' || doc.active !== false || previousDoc?.active === false) return doc
  const { revokeAllExternalSessionsForUser, revokeExternalIdentityForUser } =
    await import('@/lib/xero/identity/service')
  await revokeAllExternalSessionsForUser(req.payload, doc.id, 'account-deactivated', req)
  await revokeExternalIdentityForUser(
    req.payload,
    doc.id,
    'Identity link revoked when the local account was deactivated.',
    req,
  )
  return doc
}

const auditUserAdministration: CollectionAfterChangeHook = async ({
  doc,
  operation,
  previousDoc,
  req,
}) => {
  if (operation !== 'update' || !previousDoc) return doc
  const { recordAuditEvent } = await import('@/lib/audit/service')
  const actor = req.user && typeof req.user === 'object' ? req.user.id : undefined
  if (previousDoc.role !== doc.role && req.context?.[OWNER_TRANSITION_CONTEXT] !== true) {
    await recordAuditEvent(
      req.payload,
      {
        actor,
        after: { role: doc.role },
        before: { role: previousDoc.role },
        eventType: 'user.role-changed',
        targetCollection: 'users',
        targetId: doc.id,
      },
      req,
    )
  }
  if (previousDoc.active !== doc.active) {
    await recordAuditEvent(
      req.payload,
      {
        actor,
        after: { active: doc.active },
        before: { active: previousDoc.active },
        eventType: 'user.status-changed',
        targetCollection: 'users',
        targetId: doc.id,
      },
      req,
    )
  }
  return doc
}

const addSafeLoginDiagnostics: CollectionAfterReadHook = async ({ doc, req }) => {
  if (!isActiveOwnerOrAdmin(req.user) || req.transactionID) return doc
  // MongoDB transactions must not run parallel operations on one session.
  const identities = await req.payload.find({
    collection: 'auth-identities',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { and: [{ user: { equals: doc.id } }, { provider: { equals: 'xero' } }] },
  })
  const sessions = await req.payload.count({
    collection: 'external-auth-sessions',
    overrideAccess: true,
    req,
    where: {
      and: [
        { user: { equals: doc.id } },
        { status: { equals: 'active' } },
        { absoluteExpiresAt: { greater_than: new Date().toISOString() } },
      ],
    },
  })
  const identity = identities.docs[0]
  const maskedEmail = identity?.emailSnapshot
    ? identity.emailSnapshot.replace(/^(.).*(@.*)$/, '$1***$2')
    : null
  doc.linkedXeroDisplay = identity
    ? `${identity.displayNameSnapshot || 'Xero identity'}${maskedEmail ? ` (${maskedEmail})` : ''} — ${identity.status}`
    : 'Not linked'
  doc.activeExternalSessionCount = sessions.totalDocs
  return doc
}

const resetPasswordEmailHTML = ({ token }: { token?: string } = {}): string => {
  if (!token || !/^[a-f0-9]{40}$/i.test(token)) {
    return '<p>A password reset was requested, but no valid reset link could be generated.</p>'
  }

  const url = new URL('/reset-password', environment.serverURL)
  url.searchParams.set('token', token)
  const resetURL = url.toString()

  return [
    '<p>A password reset was requested for your Project Time account.</p>',
    `<p><a href="${resetURL}">Choose a new password</a></p>`,
    '<p>This link expires in 30 minutes. If you did not request it, you can ignore this email.</p>',
  ].join('')
}

const verificationEmailHTML = ({ token }: { token: string }): string => {
  const url = new URL('/verify-email', environment.serverURL)
  url.searchParams.set('token', token)
  return [
    '<p>Confirm your email address for Project Time.</p>',
    `<p><a href="${url.toString()}">Verify email address</a></p>`,
    '<p>If you did not expect this message, contact your administrator.</p>',
  ].join('')
}

/** Covers create, password change, and Payload's direct reset-password operation. */
export const enforcePasswordPolicy: CollectionBeforeOperationHook = ({ args, operation, req }) => {
  if (
    operation === 'forgotPassword' &&
    !canDeliverAccountEmail(req.payload) &&
    (!('disableEmail' in args) || args.disableEmail !== true)
  ) {
    throw new AuthenticationError(req.t)
  }
  if (operation !== 'create' && operation !== 'update' && operation !== 'resetPassword') return

  const data: null | Record<string, unknown> =
    'data' in args && isRecord(args.data) ? (args.data as Record<string, unknown>) : null
  if (!data || !Object.hasOwn(data, 'password')) return

  if (typeof data.password !== 'string' || data.password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError({
      collection: 'users',
      errors: [
        {
          message: `Password must contain at least ${MIN_PASSWORD_LENGTH} characters.`,
          path: 'password',
        },
      ],
      req,
    })
  }
}

const revokeOtherSessionsAfterPasswordReset: CollectionAfterOperationHook = async ({
  operation,
  req,
  result,
}) => {
  if (operation !== 'resetPassword' || !result || typeof result !== 'object') return result
  const resetResult = result as { token?: unknown; user?: unknown }
  if (
    typeof resetResult.token !== 'string' ||
    !resetResult.user ||
    typeof resetResult.user !== 'object'
  ) {
    return result
  }

  const userID = 'id' in resetResult.user ? resetResult.user.id : null
  if (typeof userID !== 'string' && typeof userID !== 'number') return result

  let sessionID: string | null = null
  try {
    const decoded = decodeJwt(resetResult.token)
    sessionID = typeof decoded.sid === 'string' ? decoded.sid : null
  } catch {
    // A token generated by Payload should always decode; fail closed by retaining no session.
  }

  const user = await req.payload.findByID({
    collection: 'users',
    depth: 0,
    id: userID,
    overrideAccess: true,
    req,
    showHiddenFields: true,
  })
  const sessions = sessionID
    ? (user.sessions ?? []).filter((session) => session.id === sessionID)
    : []
  await req.payload.update({
    collection: 'users',
    id: userID,
    data: {
      resetPasswordExpiration: null,
      resetPasswordToken: null,
      sessions,
    },
    overrideAccess: true,
    req,
  })
  // A reset is a credential recovery: Xero sign-in sessions must end with the old password's.
  const { revokeAllExternalSessionsForUser } = await import('@/lib/xero/identity/service')
  await revokeAllExternalSessionsForUser(req.payload, userID, 'password-reset', req)
  return result
}

export const Users: CollectionConfig = {
  slug: 'users',
  access: {
    admin: canAccessPayloadAdmin,
    create: canCreateUsers,
    delete: canDeleteUsers,
    read: canReadUsers,
    unlock: canUnlockUsers,
    update: canUpdateUsers,
  },
  admin: {
    defaultColumns: ['displayName', 'email', 'role', 'active', 'timezone'],
    group: 'People',
    useAsTitle: 'displayName',
  },
  auth: {
    cookies: {
      sameSite: 'Lax',
      secure: process.env.NODE_ENV === 'production',
    },
    lockTime: 15 * 60 * 1_000,
    maxLoginAttempts: 5,
    strategies: [xeroExternalSessionStrategy],
    forgotPassword: {
      expiration: 30 * 60 * 1_000,
      generateEmailHTML: resetPasswordEmailHTML,
      generateEmailSubject: () => 'Reset your Project Time password',
    },
    tokenExpiration: 2 * 60 * 60,
    useSessions: true,
    verify: {
      generateEmailHTML: verificationEmailHTML,
      generateEmailSubject: () => 'Verify your Project Time email address',
    },
  },
  disableDuplicate: true,
  fields: [
    {
      name: 'displayName',
      type: 'text',
      index: true,
      maxLength: 120,
      required: true,
      hooks: {
        beforeValidate: [({ value }) => (typeof value === 'string' ? value.trim() : value)],
      },
      validate: (value: null | string | undefined) =>
        (typeof value === 'string' && value.trim().length > 0) || 'Display name is required.',
    },
    {
      name: 'role',
      type: 'select',
      access: {
        create: canSetUserRole,
        update: canSetUserRole,
      },
      admin: {
        position: 'sidebar',
      },
      defaultValue: 'member',
      index: true,
      options: USER_ROLES.map((role) => ({
        label: role.charAt(0).toUpperCase() + role.slice(1),
        value: role,
      })),
      required: true,
    },
    {
      name: 'active',
      type: 'checkbox',
      access: {
        create: canSetUserActiveState,
        update: canSetUserActiveState,
      },
      admin: {
        description: 'Inactive users are denied application and Payload Admin authorization.',
        position: 'sidebar',
      },
      defaultValue: false,
      index: true,
      required: true,
    },
    {
      name: 'bootstrapMarker',
      type: 'text',
      access: {
        create: () => false,
        read: () => false,
        update: () => false,
      },
      admin: {
        hidden: true,
      },
      hidden: true,
      unique: true,
    },
    {
      name: 'timezone',
      type: 'text',
      admin: {
        description: 'IANA timezone, for example Pacific/Auckland.',
        position: 'sidebar',
      },
      defaultValue: 'Pacific/Auckland',
      required: true,
      validate: validateIanaTimezone,
    },
    {
      name: 'enabledLoginMethods',
      type: 'select',
      hasMany: true,
      defaultValue: ['email-password'],
      options: [
        { label: 'Email and password', value: 'email-password' },
        { label: 'Xero identity', value: 'xero' },
      ],
      access: {
        create: () => false,
        update: () => false,
      },
      admin: {
        description: 'Managed by protected authentication workflows.',
        readOnly: true,
        position: 'sidebar',
      },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'lastLoginProvider',
          type: 'select',
          options: [
            { label: 'Email and password', value: 'email-password' },
            { label: 'Xero identity', value: 'xero' },
          ],
          access: { create: () => false, update: () => false },
          admin: { readOnly: true },
        },
        {
          name: 'lastLoginAt',
          type: 'date',
          access: { create: () => false, update: () => false },
          admin: { readOnly: true },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'linkedXeroDisplay',
          type: 'text',
          virtual: true,
          access: { read: ({ req }) => isActiveOwnerOrAdmin(req.user) },
          admin: { readOnly: true },
        },
        {
          name: 'activeExternalSessionCount',
          type: 'number',
          virtual: true,
          access: { read: ({ req }) => isActiveOwnerOrAdmin(req.user) },
          admin: { readOnly: true },
        },
      ],
    },
  ],
  hooks: {
    afterChange: [
      revokeExternalSessionsWhenDeactivated,
      revokeExternalSessionsAfterPasswordChange,
      auditUserAdministration,
    ],
    afterLogout: [revokeExternalSessionOnLogout],
    afterOperation: [revokeOtherSessionsAfterPasswordReset],
    afterRead: [addSafeLoginDiagnostics],
    beforeChange: [
      rejectGenericOwnCredentialChanges,
      revokeSessionsWhenDeactivated,
      revokeSessionsWhenPasswordChanges,
    ],
    beforeLogin: [rejectInactiveLogin],
    beforeOperation: [enforcePasswordPolicy],
    beforeValidate: [bootstrapFirstOwner],
    refresh: [rejectInactiveRefresh],
  },
}
