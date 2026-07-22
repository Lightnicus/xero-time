'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'

import { AccountLifecycleError, acceptInvitation } from '@/lib/account-lifecycle/service'
import { setPayloadSessionCookie } from '@/lib/member-app/auth-cookie'
import { defaultAppHome } from '@/lib/member-app/navigation'
import { enforceRateLimit, rateLimitKey } from '@/lib/security/rate-limit'
import config from '@/payload.config'

export type AcceptInvitationState = {
  message: string | null
}

const value = (formData: FormData, name: string): string => {
  const input = formData.get(name)
  return typeof input === 'string' ? input : ''
}

export async function acceptInvitationAction(
  _previousState: AcceptInvitationState,
  formData: FormData,
): Promise<AcceptInvitationState> {
  const token = value(formData, 'token')
  const password = value(formData, 'password')
  const confirmation = value(formData, 'passwordConfirmation')
  if (password !== confirmation) return { message: 'The passwords do not match.' }

  const payload = await getPayload({ config })
  let destination = '/app'
  try {
    await enforceRateLimit(payload, {
      key: rateLimitKey(await headers(), token.slice(0, 32)),
      limit: 8,
      scope: 'authentication.invite-acceptance',
      windowMs: 30 * 60_000,
    })
    const user = await acceptInvitation(payload, { password, token })
    const login = await payload.login({
      collection: 'users',
      data: { email: user.email, password },
    })
    if (!login.token) throw new Error('Invitation acceptance did not create a session.')
    await setPayloadSessionCookie(payload, login.token)
    destination = defaultAppHome(user.role)
  } catch (error) {
    return {
      message:
        error instanceof AccountLifecycleError
          ? error.message
          : 'The invitation is invalid, expired, or already used.',
    }
  }

  redirect(destination)
}
