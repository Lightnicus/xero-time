'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { ValidationError } from 'payload'

import { AccountLifecycleError, changeOwnPassword } from '@/lib/account-lifecycle/service'
import { isValidIanaTimezone } from '@/lib/domain/validation'
import { setPayloadSessionCookie } from '@/lib/member-app/auth-cookie'
import { requireAppSession } from '@/lib/member-app/session'
import { enforceRateLimit, rateLimitKey } from '@/lib/security/rate-limit'
import { IdentityIntegrationError } from '@/lib/xero/identity/contracts'
import { revokeExternalSession, unlinkIdentity } from '@/lib/xero/identity/service'

export type ProfileField = 'displayName' | 'timezone'

export type ProfileActionState = {
  fieldErrors?: Partial<Record<ProfileField, string>>
  message: string | null
}

export type PasswordActionState = {
  message: string | null
}

const stringValue = (formData: FormData, name: string): string => {
  const value = formData.get(name)
  return typeof value === 'string' ? value : ''
}

export async function updateProfileAction(
  _previousState: ProfileActionState,
  formData: FormData,
): Promise<ProfileActionState> {
  const session = await requireAppSession()
  const displayName = stringValue(formData, 'displayName').trim()
  const timezone = stringValue(formData, 'timezone')
  const fieldErrors: NonNullable<ProfileActionState['fieldErrors']> = {}

  if (displayName.length === 0) {
    fieldErrors.displayName = 'Enter your display name.'
  } else if (displayName.length > 120) {
    fieldErrors.displayName = 'Keep your display name to 120 characters or fewer.'
  }

  if (!isValidIanaTimezone(timezone)) {
    fieldErrors.timezone = 'Select a valid IANA timezone.'
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      fieldErrors,
      message: 'Check the highlighted fields and try again.',
    }
  }

  try {
    await session.payload.update({
      collection: 'users',
      id: session.user.id,
      data: { displayName, timezone },
      overrideAccess: false,
      req: session.req,
    })
  } catch (error) {
    if (error instanceof ValidationError) {
      const payloadErrors: NonNullable<ProfileActionState['fieldErrors']> = {}

      for (const item of error.data.errors) {
        if (item.path === 'displayName' || item.path === 'timezone') {
          payloadErrors[item.path] = item.message
        }
      }

      return {
        fieldErrors: payloadErrors,
        message: error.data.errors[0]?.message ?? 'Your profile could not be saved.',
      }
    }

    return { message: 'Your profile could not be saved. Please try again.' }
  }

  revalidatePath('/app', 'layout')
  redirect('/app/profile?saved=1')
}

export async function changePasswordAction(
  _previousState: PasswordActionState,
  formData: FormData,
): Promise<PasswordActionState> {
  const session = await requireAppSession()
  const currentPassword = stringValue(formData, 'currentPassword')
  const newPassword = stringValue(formData, 'newPassword')
  const confirmation = stringValue(formData, 'passwordConfirmation')
  if (newPassword !== confirmation) return { message: 'The new passwords do not match.' }

  try {
    await enforceRateLimit(session.payload, {
      key: rateLimitKey(await headers(), String(session.user.id)),
      limit: 8,
      scope: 'authentication.password-change',
      windowMs: 30 * 60_000,
    })
    const token = await changeOwnPassword(session, currentPassword, newPassword)
    await setPayloadSessionCookie(session.payload, token)
  } catch (error) {
    return {
      message:
        error instanceof AccountLifecycleError
          ? error.message
          : 'Your password could not be changed.',
    }
  }

  redirect('/app/profile?password=changed')
}

export async function revokeExternalSessionAction(formData: FormData): Promise<void> {
  const session = await requireAppSession()
  const sessionID = stringValue(formData, 'sessionID')
  try {
    await enforceRateLimit(session.payload, {
      key: rateLimitKey(await headers(), String(session.user.id)),
      limit: 20,
      scope: 'authentication.session-revocation',
      windowMs: 30 * 60_000,
    })
    await revokeExternalSession(session, sessionID)
  } catch {
    redirect('/app/profile?security=failed')
  }
  revalidatePath('/app/profile')
  redirect('/app/profile?security=session-revoked')
}

export async function unlinkXeroIdentityAction(formData: FormData): Promise<void> {
  const session = await requireAppSession()
  try {
    await enforceRateLimit(session.payload, {
      key: rateLimitKey(await headers(), String(session.user.id)),
      limit: 8,
      scope: 'authentication.identity-unlink',
      windowMs: 30 * 60_000,
    })
    await unlinkIdentity(session, {
      password: stringValue(formData, 'password'),
      reason: stringValue(formData, 'reason'),
    })
  } catch (error) {
    const code = error instanceof IdentityIntegrationError ? error.code : 'failed'
    redirect(`/app/profile?security=${encodeURIComponent(code)}`)
  }
  revalidatePath('/app', 'layout')
  redirect('/app/profile?security=identity-unlinked')
}
