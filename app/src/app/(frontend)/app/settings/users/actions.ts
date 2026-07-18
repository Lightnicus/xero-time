'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { OwnerTransitionError, transitionOwner } from '@/lib/account-lifecycle/owner-transition'
import {
  AccountLifecycleError,
  issueInvitation,
  resendInvitation,
  revokeInvitation,
  type InviteRole,
} from '@/lib/account-lifecycle/service'
import { requireAppSession } from '@/lib/member-app/session'
import { enforceRateLimit, rateLimitKey } from '@/lib/security/rate-limit'
import { IdentityIntegrationError } from '@/lib/xero/identity/contracts'
import { recoverExternalIdentityForUser } from '@/lib/xero/identity/service'

export type InvitationActionState = {
  message: string | null
  setupURL?: string
  success?: boolean
}

const stringValue = (formData: FormData, name: string): string => {
  const value = formData.get(name)
  return typeof value === 'string' ? value : ''
}

const safeMessage = (error: unknown): string => {
  if (error instanceof AccountLifecycleError) return error.message
  return 'The invitation operation could not be completed.'
}

const developmentSetupURL = (url: string): string | undefined =>
  process.env.NODE_ENV === 'production' ? undefined : url

const limitUserAdministration = async (
  session: Awaited<ReturnType<typeof requireAppSession>>,
): Promise<void> =>
  enforceRateLimit(session.payload, {
    key: rateLimitKey(await headers(), String(session.user.id)),
    limit: 30,
    scope: 'command.user-administration',
    windowMs: 15 * 60_000,
  })

export async function createInvitationAction(
  _previousState: InvitationActionState,
  formData: FormData,
): Promise<InvitationActionState> {
  const session = await requireAppSession()

  try {
    await limitUserAdministration(session)
    const result = await issueInvitation(session, {
      displayName: stringValue(formData, 'displayName'),
      email: stringValue(formData, 'email'),
      role: stringValue(formData, 'role') as InviteRole,
      timezone: stringValue(formData, 'timezone'),
    })
    revalidatePath('/app/settings/users')
    return {
      message: result.delivered
        ? 'Invitation issued. Any earlier link for this email is now invalid.'
        : 'Invitation issued, but email delivery could not be confirmed. Rotate and resend after configuring email.',
      setupURL: developmentSetupURL(result.setupURL),
      success: true,
    }
  } catch (error) {
    return { message: safeMessage(error), success: false }
  }
}

export async function resendInvitationAction(
  _previousState: InvitationActionState,
  formData: FormData,
): Promise<InvitationActionState> {
  const session = await requireAppSession()
  try {
    await limitUserAdministration(session)
    const result = await resendInvitation(session, stringValue(formData, 'invitationID'))
    revalidatePath('/app/settings/users')
    return {
      message: result.delivered
        ? 'A new invitation link was issued; the previous link is invalid.'
        : 'A new link was issued, but email delivery could not be confirmed.',
      setupURL: developmentSetupURL(result.setupURL),
      success: true,
    }
  } catch (error) {
    return { message: safeMessage(error), success: false }
  }
}

export async function revokeInvitationAction(
  _previousState: InvitationActionState,
  formData: FormData,
): Promise<InvitationActionState> {
  const session = await requireAppSession()
  try {
    await limitUserAdministration(session)
    await revokeInvitation(
      session,
      stringValue(formData, 'invitationID'),
      stringValue(formData, 'reason'),
    )
    revalidatePath('/app/settings/users')
    return { message: 'Invitation revoked. Its setup link can no longer be used.', success: true }
  } catch (error) {
    return { message: safeMessage(error), success: false }
  }
}

export async function ownerTransitionAction(formData: FormData): Promise<void> {
  const session = await requireAppSession()
  try {
    await limitUserAdministration(session)
    await transitionOwner(session, {
      action: stringValue(formData, 'action') === 'demote' ? 'demote' : 'promote',
      password: stringValue(formData, 'password'),
      reason: stringValue(formData, 'reason'),
      targetUserID: stringValue(formData, 'targetUserID'),
    })
  } catch (error) {
    const code = error instanceof OwnerTransitionError ? error.code : 'failed'
    redirect(`/app/settings/users?ownership=${encodeURIComponent(code)}`)
  }
  revalidatePath('/app/settings/users')
  redirect('/app/settings/users?ownership=changed')
}

export async function recoverIdentityAction(formData: FormData): Promise<void> {
  const session = await requireAppSession()
  try {
    await limitUserAdministration(session)
    await recoverExternalIdentityForUser(session, {
      confirmation: stringValue(formData, 'confirmation'),
      password: stringValue(formData, 'password'),
      reason: stringValue(formData, 'reason'),
      targetUserID: stringValue(formData, 'targetUserID'),
    })
  } catch (error) {
    const code = error instanceof IdentityIntegrationError ? error.code : 'failed'
    redirect(`/app/settings/users?identityRecovery=${encodeURIComponent(code)}`)
  }
  revalidatePath('/app/settings/users')
  redirect('/app/settings/users?identityRecovery=revoked')
}
