import 'server-only'

import { canDeliverAccountEmail } from '@/lib/account-email'
import type { AppSession } from '@/lib/member-app/session'
import type { User } from '@/payload-types'

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password-policy'

import type { Payload } from 'payload'

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class AccountLifecycleError extends Error {
  code: string

  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'AccountLifecycleError'
    this.code = code
  }
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase()

const assertPassword = (password: string): void => {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new AccountLifecycleError(
      'invalid-password',
      `Password must contain at least ${MIN_PASSWORD_LENGTH} characters.`,
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
