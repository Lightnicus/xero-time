import 'server-only'

import { createHash, randomBytes } from 'node:crypto'

import { hasActiveRole } from '@/access/roles'
import { canDeliverAccountEmail } from '@/lib/account-email'
import { recordAuditEvent } from '@/lib/audit/service'
import { isValidIanaTimezone } from '@/lib/domain/validation'
import { environment } from '@/lib/env'
import type { AppSession } from '@/lib/member-app/session'
import { requireMongoModel } from '@/lib/payload/mongo'
import { withPayloadTransaction } from '@/lib/payload/withTransaction'
import type { Invitation, User } from '@/payload-types'

import { ACCOUNT_INVITATION_ACCEPTANCE_CONTEXT } from './context'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password-policy'

import type { Payload, PayloadRequest } from 'payload'

export const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000
const INVITATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type InviteRole = 'admin' | 'biller' | 'member'

export class AccountLifecycleError extends Error {
  code: string

  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'AccountLifecycleError'
    this.code = code
  }
}

export type InvitationMailer = (input: {
  displayName: string
  email: string
  expiresAt: string
  role: InviteRole
  setupURL: string
}) => Promise<void>

export type InvitationManagementItem = {
  deliveryStatus: Invitation['deliveryStatus']
  displayName: string
  email: string
  expiresAt: string
  id: string
  issuedAt: string
  role: InviteRole
  status: 'accepted' | 'expired' | 'pending' | 'revoked'
}

type InvitationInput = {
  displayName: string
  email: string
  role: InviteRole
  timezone: string
}

const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('base64url')

const randomToken = (): string => randomBytes(32).toString('base64url')

const normalizeEmail = (email: string): string => email.trim().toLowerCase()

const assertEmail = (email: string): void => {
  if (email.length === 0 || email.length > 320 || !emailPattern.test(email)) {
    throw new AccountLifecycleError('invalid-email', 'Enter a valid email address.')
  }
}

const assertPassword = (password: string): void => {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new AccountLifecycleError(
      'invalid-password',
      `Password must contain at least ${MIN_PASSWORD_LENGTH} characters.`,
    )
  }
}

const assertAccountManager = (session: AppSession): void => {
  if (!hasActiveRole(session.user, ['owner', 'admin'])) {
    throw new AccountLifecycleError(
      'forbidden',
      'Only an owner or administrator can manage invitations.',
    )
  }
}

const assertManageableRole: (session: AppSession, role: string) => asserts role is InviteRole = (
  session,
  role,
) => {
  const allowed =
    session.user.role === 'owner'
      ? ['admin', 'biller', 'member']
      : session.user.role === 'admin'
        ? ['biller', 'member']
        : []

  if (!allowed.includes(role)) {
    throw new AccountLifecycleError('invalid-role', 'You cannot invite a user with that role.')
  }
}

const defaultInvitationMailer =
  (payload: Payload): InvitationMailer =>
  async (input) => {
    if (!canDeliverAccountEmail(payload)) {
      throw new AccountLifecycleError(
        'email-delivery-disabled',
        'Account email delivery is not configured.',
      )
    }
    await payload.sendEmail({
      subject: 'Set up your Project Time account',
      text: [
        `Hello ${input.displayName},`,
        '',
        `You have been invited to Project Time as ${input.role}.`,
        `Set up your account before ${input.expiresAt}:`,
        input.setupURL,
        '',
        'If you were not expecting this invitation, ignore this message.',
      ].join('\n'),
      to: input.email,
    })
  }

const setupURL = (token: string): string => {
  const url = new URL('/invite', environment.serverURL)
  url.searchParams.set('token', token)
  return url.toString()
}

const findInvitationByEmail = async (
  session: AppSession,
  email: string,
): Promise<Invitation | null> => {
  const result = await session.payload.find({
    collection: 'invitations',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req: session.req,
    showHiddenFields: true,
    where: { email: { equals: email } },
  })
  return result.docs[0] ?? null
}

const assertNoExistingUser = async (session: AppSession, email: string): Promise<void> => {
  const users = await session.payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req: session.req,
    where: { email: { equals: email } },
  })
  if (users.docs.length > 0) {
    throw new AccountLifecycleError('user-exists', 'A user with that email already exists.')
  }
}

export async function issueInvitation(
  session: AppSession,
  input: InvitationInput,
  mailer: InvitationMailer = defaultInvitationMailer(session.payload),
): Promise<{ delivered: boolean; invitation: Invitation; setupURL: string }> {
  assertAccountManager(session)
  assertManageableRole(session, input.role)

  const email = normalizeEmail(input.email)
  const displayName = input.displayName.trim()
  assertEmail(email)
  if (displayName.length === 0 || displayName.length > 120) {
    throw new AccountLifecycleError(
      'invalid-name',
      'Enter a display name of 120 characters or fewer.',
    )
  }
  if (!isValidIanaTimezone(input.timezone) || input.timezone.length > 100) {
    throw new AccountLifecycleError('invalid-timezone', 'Select a valid timezone.')
  }

  await assertNoExistingUser(session, email)
  const existing = await findInvitationByEmail(session, email)
  if (existing?.status === 'accepted') {
    throw new AccountLifecycleError('invitation-accepted', 'That invitation was already accepted.')
  }

  const token = randomToken()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + INVITATION_LIFETIME_MS).toISOString()
  const data = {
    acceptedAt: null,
    acceptedBy: null,
    cleanupAt: new Date(
      now.getTime() + INVITATION_LIFETIME_MS + INVITATION_RETENTION_MS,
    ).toISOString(),
    deliveryStatus: 'pending' as const,
    displayName,
    email,
    expiresAt,
    invitedBy: session.user.id,
    issuedAt: now.toISOString(),
    lastDeliveryError: null,
    lastDeliveredAt: null,
    revocationReason: null,
    revokedAt: null,
    revokedBy: null,
    role: input.role,
    status: 'pending' as const,
    timezone: input.timezone,
    tokenHash: hashToken(token),
  }

  const invitation = existing
    ? await session.payload.update({
        collection: 'invitations',
        id: existing.id,
        data: { ...data, deliveryAttempts: existing.deliveryAttempts + 1 },
        overrideAccess: true,
        req: session.req,
        showHiddenFields: true,
      })
    : await session.payload.create({
        collection: 'invitations',
        data: { ...data, deliveryAttempts: 1 },
        overrideAccess: true,
        req: session.req,
        showHiddenFields: true,
      })

  const invitationSetupURL = setupURL(token)
  let delivered = false
  try {
    await mailer({
      displayName,
      email,
      expiresAt,
      role: input.role,
      setupURL: invitationSetupURL,
    })
    delivered = true
  } catch {
    // Delivery is outside the persistence transaction. The operator can rotate and resend safely.
  }

  const updated = await session.payload.update({
    collection: 'invitations',
    id: invitation.id,
    data: {
      deliveryStatus: delivered ? 'sent' : 'failed',
      lastDeliveredAt: delivered ? new Date().toISOString() : null,
      lastDeliveryError: delivered ? null : 'email-delivery-failed',
    },
    overrideAccess: true,
    req: session.req,
    showHiddenFields: true,
  })

  await recordAuditEvent(
    session.payload,
    {
      actor: session.user.id,
      after: { deliveryStatus: updated.deliveryStatus, role: updated.role },
      eventType: 'invitation.created',
      targetCollection: 'invitations',
      targetId: updated.id,
    },
    session.req,
  )

  return { delivered, invitation: updated, setupURL: invitationSetupURL }
}

export async function resendInvitation(
  session: AppSession,
  invitationID: string,
  mailer?: InvitationMailer,
): Promise<{ delivered: boolean; invitation: Invitation; setupURL: string }> {
  assertAccountManager(session)
  let invitation: Invitation
  try {
    invitation = await session.payload.findByID({
      collection: 'invitations',
      depth: 0,
      id: invitationID,
      overrideAccess: true,
      req: session.req,
      showHiddenFields: true,
    })
  } catch (error) {
    throw new AccountLifecycleError('invalid-invitation', 'The invitation is unavailable.', {
      cause: error,
    })
  }
  if (invitation.status === 'accepted') {
    throw new AccountLifecycleError('invitation-accepted', 'That invitation was already accepted.')
  }

  return issueInvitation(
    session,
    {
      displayName: invitation.displayName,
      email: invitation.email,
      role: invitation.role,
      timezone: invitation.timezone,
    },
    mailer,
  )
}

export async function revokeInvitation(
  session: AppSession,
  invitationID: string,
  reason: string,
): Promise<void> {
  assertAccountManager(session)
  const normalizedReason = reason.trim()
  if (normalizedReason.length < 10 || normalizedReason.length > 1_000) {
    throw new AccountLifecycleError(
      'invalid-reason',
      'Enter a revocation reason of at least 10 characters.',
    )
  }

  let invitation: Invitation
  try {
    invitation = await session.payload.findByID({
      collection: 'invitations',
      depth: 0,
      id: invitationID,
      overrideAccess: true,
      req: session.req,
      showHiddenFields: true,
    })
  } catch (error) {
    throw new AccountLifecycleError('invalid-invitation', 'The invitation is unavailable.', {
      cause: error,
    })
  }
  assertManageableRole(session, invitation.role)

  const revoked = await requireMongoModel(session.payload, 'invitations').findOneAndUpdate(
    { _id: invitation.id, status: 'pending' },
    {
      $set: {
        cleanupAt: new Date(Date.now() + INVITATION_RETENTION_MS),
        revocationReason: normalizedReason,
        revokedAt: new Date(),
        revokedBy: session.user.id,
        status: 'revoked',
      },
    },
    { new: true },
  )
  if (!revoked) {
    throw new AccountLifecycleError('invalid-invitation', 'The invitation is unavailable.')
  }
  await recordAuditEvent(
    session.payload,
    {
      actor: session.user.id,
      eventType: 'invitation.revoked',
      reason: normalizedReason,
      targetCollection: 'invitations',
      targetId: invitation.id,
    },
    session.req,
  )
}

const effectiveStatus = (invitation: Invitation): InvitationManagementItem['status'] => {
  if (invitation.status === 'pending' && new Date(invitation.expiresAt).getTime() <= Date.now()) {
    return 'expired'
  }
  return invitation.status === 'accepting' ? 'pending' : invitation.status
}

export async function getInvitationManagementView(
  session: AppSession,
): Promise<InvitationManagementItem[]> {
  assertAccountManager(session)
  const invitations = await session.payload.find({
    collection: 'invitations',
    depth: 0,
    limit: 100,
    overrideAccess: true,
    req: session.req,
    sort: '-issuedAt',
  })

  return invitations.docs.map((invitation) => ({
    deliveryStatus: invitation.deliveryStatus,
    displayName: invitation.displayName,
    email: invitation.email,
    expiresAt: invitation.expiresAt,
    id: String(invitation.id),
    issuedAt: invitation.issuedAt,
    role: invitation.role,
    status: effectiveStatus(invitation),
  }))
}

const tokenShapeIsValid = (token: string): boolean =>
  token.length >= 40 && token.length <= 100 && /^[A-Za-z0-9_-]+$/.test(token)

export const findUsableInvitation = async (
  payload: Payload,
  token: string,
  req?: PayloadRequest,
): Promise<Invitation | null> => {
  if (!tokenShapeIsValid(token)) return null
  const result = await payload.find({
    collection: 'invitations',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    showHiddenFields: true,
    where: { tokenHash: { equals: hashToken(token) } },
  })
  const invitation = result.docs[0]
  if (
    !invitation ||
    invitation.status !== 'pending' ||
    new Date(invitation.expiresAt).getTime() <= Date.now()
  ) {
    return null
  }
  return invitation
}

const maskedEmail = (email: string): string => {
  const [local, domain] = email.split('@')
  return `${local?.slice(0, 1) ?? '*'}***@${domain ?? 'unknown'}`
}

export async function getInvitationPreview(
  payload: Payload,
  token: string,
): Promise<null | { displayName: string; email: string; role: InviteRole }> {
  const invitation = await findUsableInvitation(payload, token)
  return invitation
    ? {
        displayName: invitation.displayName,
        email: maskedEmail(invitation.email),
        role: invitation.role,
      }
    : null
}

export async function acceptInvitation(
  payload: Payload,
  input: { password: string; token: string },
): Promise<User> {
  assertPassword(input.password)
  if (!tokenShapeIsValid(input.token)) {
    throw new AccountLifecycleError(
      'invalid-invitation',
      'The invitation is invalid, expired, or already used.',
    )
  }

  try {
    return await withPayloadTransaction(
      payload,
      async (req) => {
        const invitation = await findUsableInvitation(payload, input.token, req)
        if (!invitation) {
          throw new AccountLifecycleError(
            'invalid-invitation',
            'The invitation is invalid, expired, or already used.',
          )
        }

        const transactionID = await req.transactionID
        const mongoSession = transactionID ? payload.db.sessions[transactionID] : undefined
        const claimed = await requireMongoModel(payload, 'invitations').findOneAndUpdate(
          {
            _id: invitation.id,
            expiresAt: { $gt: new Date() },
            status: 'pending',
            tokenHash: hashToken(input.token),
          },
          { $set: { status: 'accepting' } },
          { new: true, session: mongoSession },
        )
        if (!claimed) {
          throw new AccountLifecycleError(
            'invalid-invitation',
            'The invitation is invalid, expired, or already used.',
          )
        }

        const existingUsers = await payload.find({
          collection: 'users',
          depth: 0,
          limit: 1,
          overrideAccess: true,
          req,
          where: { email: { equals: invitation.email } },
        })
        if (existingUsers.docs.length > 0) {
          throw new AccountLifecycleError(
            'invalid-invitation',
            'The invitation is invalid, expired, or already used.',
          )
        }

        const user = await payload.create({
          collection: 'users',
          data: {
            _verified: true,
            active: true,
            displayName: invitation.displayName,
            email: invitation.email,
            password: input.password,
            role: invitation.role,
            timezone: invitation.timezone,
          },
          overrideAccess: true,
          req,
        })

        await payload.update({
          collection: 'invitations',
          id: invitation.id,
          data: {
            acceptedAt: new Date().toISOString(),
            acceptedBy: user.id,
            acceptanceProvider: 'email-password',
            cleanupAt: new Date(Date.now() + INVITATION_RETENTION_MS).toISOString(),
            status: 'accepted',
          },
          overrideAccess: true,
          req,
        })
        await recordAuditEvent(
          payload,
          {
            actor: user.id,
            eventType: 'invitation.accepted',
            metadata: { acceptanceProvider: 'email-password' },
            targetCollection: 'invitations',
            targetId: invitation.id,
          },
          req,
        )
        return user
      },
      { context: { [ACCOUNT_INVITATION_ACCEPTANCE_CONTEXT]: true } },
    )
  } catch (error) {
    if (error instanceof AccountLifecycleError) throw error
    throw new AccountLifecycleError(
      'invalid-invitation',
      'The invitation is invalid, expired, or already used.',
      { cause: error },
    )
  }
}

export async function changeOwnPassword(
  session: AppSession,
  currentPassword: string,
  newPassword: string,
): Promise<string> {
  assertPassword(newPassword)
  if (currentPassword.length === 0 || currentPassword.length > 1_024) {
    throw new AccountLifecycleError('password-change-failed', 'Password confirmation failed.')
  }
  if (currentPassword === newPassword) {
    throw new AccountLifecycleError(
      'password-unchanged',
      'Choose a new password that differs from the current password.',
    )
  }

  try {
    const confirmation = await session.payload.login({
      collection: 'users',
      data: { email: session.user.email, password: currentPassword },
    })
    if (!confirmation.user || String(confirmation.user.id) !== String(session.user.id)) {
      throw new Error('Password confirmation resolved a different account.')
    }

    await session.payload.update({
      collection: 'users',
      id: session.user.id,
      data: { password: newPassword, sessions: [] },
      overrideAccess: true,
      req: session.req,
    })
    const { revokeAllExternalSessionsForUser } = await import('@/lib/xero/identity/service')
    await revokeAllExternalSessionsForUser(
      session.payload,
      session.user.id,
      'password-changed',
      session.req,
    )
    const login = await session.payload.login({
      collection: 'users',
      data: { email: session.user.email, password: newPassword },
    })
    if (!login.token) throw new Error('Password change did not create a replacement session.')
    return login.token
  } catch (error) {
    if (error instanceof AccountLifecycleError) throw error
    throw new AccountLifecycleError('password-change-failed', 'Password confirmation failed.', {
      cause: error,
    })
  }
}

export async function requestPasswordReset(
  payload: Payload,
  emailInput: string,
  options: { disableEmail?: boolean } = {},
): Promise<void> {
  const email = normalizeEmail(emailInput)
  if (!emailPattern.test(email) || email.length > 320) return
  if (options.disableEmail !== true && !canDeliverAccountEmail(payload)) {
    return
  }

  try {
    await payload.forgotPassword({
      collection: 'users',
      data: { email },
      disableEmail: options.disableEmail ?? false,
      overrideAccess: true,
    })
  } catch {
    // The public response is deliberately identical for unknown users and delivery failures.
  }
}

export async function completePasswordReset(
  payload: Payload,
  token: string,
  password: string,
): Promise<string> {
  assertPassword(password)
  if (token.length === 0 || token.length > 500) {
    throw new AccountLifecycleError(
      'invalid-password-reset',
      'The password reset link is invalid or expired.',
    )
  }

  try {
    const reset = await payload.resetPassword({
      collection: 'users',
      data: { password, token },
      overrideAccess: true,
    })
    const user = reset.user as unknown as User
    await payload.update({
      collection: 'users',
      id: user.id,
      data: { sessions: [] },
      overrideAccess: true,
    })
    const { revokeAllExternalSessionsForUser } = await import('@/lib/xero/identity/service')
    await revokeAllExternalSessionsForUser(payload, user.id, 'password-reset')
    const login = await payload.login({
      collection: 'users',
      data: { email: user.email, password },
    })
    if (!login.token) throw new Error('Password reset did not create a replacement session.')
    return login.token
  } catch (error) {
    if (error instanceof AccountLifecycleError) throw error
    throw new AccountLifecycleError(
      'invalid-password-reset',
      'The password reset link is invalid or expired.',
      { cause: error },
    )
  }
}
