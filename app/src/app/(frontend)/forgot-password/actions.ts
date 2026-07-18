'use server'

import { headers } from 'next/headers'
import { getPayload } from 'payload'

import { requestPasswordReset } from '@/lib/account-lifecycle/service'
import { enforceRateLimit, rateLimitKey } from '@/lib/security/rate-limit'
import config from '@/payload.config'

export type ForgotPasswordState = {
  message: string | null
  success?: boolean
}

export async function forgotPasswordAction(
  _previousState: ForgotPasswordState,
  formData: FormData,
): Promise<ForgotPasswordState> {
  const suppliedEmail = formData.get('email')
  const email = typeof suppliedEmail === 'string' ? suppliedEmail : ''
  const payload = await getPayload({ config })
  try {
    await enforceRateLimit(payload, {
      key: rateLimitKey(await headers(), email),
      limit: 5,
      scope: 'authentication.forgot-password',
      windowMs: 60 * 60_000,
    })
    await requestPasswordReset(payload, email)
  } catch {
    // The public response deliberately remains identical under rate limiting.
  }

  return {
    message:
      'If an active account matches that address, password-reset instructions have been sent.',
    success: true,
  }
}
