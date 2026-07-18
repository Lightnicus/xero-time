'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'

import { AccountLifecycleError, completePasswordReset } from '@/lib/account-lifecycle/service'
import { setPayloadSessionCookie } from '@/lib/member-app/auth-cookie'
import { enforceRateLimit, rateLimitKey } from '@/lib/security/rate-limit'
import config from '@/payload.config'

export type ResetPasswordState = {
  message: string | null
}

const value = (formData: FormData, name: string): string => {
  const input = formData.get(name)
  return typeof input === 'string' ? input : ''
}

export async function resetPasswordAction(
  _previousState: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const token = value(formData, 'token')
  const password = value(formData, 'password')
  if (password !== value(formData, 'passwordConfirmation')) {
    return { message: 'The passwords do not match.' }
  }

  const payload = await getPayload({ config })
  try {
    await enforceRateLimit(payload, {
      key: rateLimitKey(await headers(), token.slice(0, 32)),
      limit: 8,
      scope: 'authentication.password-reset',
      windowMs: 30 * 60_000,
    })
    const sessionToken = await completePasswordReset(payload, token, password)
    await setPayloadSessionCookie(payload, sessionToken)
  } catch (error) {
    return {
      message:
        error instanceof AccountLifecycleError
          ? error.message
          : 'The password reset link is invalid or expired.',
    }
  }

  redirect('/app/profile?password=reset')
}
