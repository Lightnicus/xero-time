'use server'

import { logout } from '@payloadcms/next/auth'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { after } from 'next/server'
import { generateExpiredPayloadCookie, generatePayloadCookie, getPayload } from 'payload'

import { recordAuditEvent } from '@/lib/audit/service'
import { defaultAppHome } from '@/lib/member-app/navigation'
import { enforceRateLimit, rateLimitKey } from '@/lib/security/rate-limit'
import { enqueueStaleAccountingHealthCheck } from '@/lib/xero/accounting/health-scheduling'
import { EXTERNAL_SESSION_COOKIE, revokeCurrentExternalSession } from '@/lib/xero/identity/service'
import config from '@/payload.config'

export type LoginActionState = {
  message: string | null
}

const genericLoginError = 'The email or password is incorrect.'

const safeAppPath = (value: FormDataEntryValue | null): string => {
  if (typeof value !== 'string') return '/app'

  const isAppPath = value === '/app' || value.startsWith('/app/') || value.startsWith('/app?')

  return isAppPath && !value.startsWith('//') && !value.includes('\\') ? value : '/app'
}

export async function loginAction(
  _previousState: LoginActionState,
  formData: FormData,
): Promise<LoginActionState> {
  const emailValue = formData.get('email')
  const passwordValue = formData.get('password')
  let destination = safeAppPath(formData.get('next'))

  if (
    typeof emailValue !== 'string' ||
    emailValue.length === 0 ||
    emailValue.length > 320 ||
    typeof passwordValue !== 'string' ||
    passwordValue.length === 0 ||
    passwordValue.length > 1_024
  ) {
    return { message: genericLoginError }
  }

  const payload = await getPayload({ config })
  try {
    await enforceRateLimit(payload, {
      key: rateLimitKey(await headers(), emailValue),
      limit: 10,
      scope: 'authentication.email-login',
      windowMs: 15 * 60_000,
    })
    const result = await payload.login({
      collection: 'users',
      data: {
        email: emailValue.trim(),
        password: passwordValue,
      },
    })
    const authConfig = payload.collections.users.config.auth

    if (!authConfig || !result.token || !result.user) {
      throw new Error('Login did not create a session token.')
    }

    if (destination === '/app') destination = defaultAppHome(result.user.role)

    await payload.update({
      collection: 'users',
      id: result.user.id,
      data: {
        lastLoginAt: new Date().toISOString(),
        lastLoginProvider: 'email-password',
      },
      overrideAccess: true,
    })
    await recordAuditEvent(payload, {
      actor: result.user.id,
      eventType: 'authentication.login-succeeded',
      metadata: { provider: 'email-password' },
      targetCollection: 'users',
      targetId: result.user.id,
    })

    const payloadCookie = generatePayloadCookie({
      collectionAuthConfig: authConfig,
      cookiePrefix: payload.config.cookiePrefix,
      returnCookieAsObject: true,
      token: result.token,
    })
    const cookieStore = await cookies()

    cookieStore.set(payloadCookie.name, payloadCookie.value ?? '', {
      domain: payloadCookie.domain,
      expires: payloadCookie.expires ? new Date(payloadCookie.expires) : undefined,
      httpOnly: payloadCookie.httpOnly,
      path: payloadCookie.path,
      sameSite: payloadCookie.sameSite?.toLowerCase() as 'lax' | 'none' | 'strict' | undefined,
      secure: payloadCookie.secure,
    })
    after(async () => {
      try {
        await enqueueStaleAccountingHealthCheck(payload, result.user as never)
      } catch {
        // Login success is deliberately independent of accounting maintenance.
      }
    })
  } catch {
    await recordAuditEvent(payload, {
      eventType: 'authentication.login-failed',
      machineActor: 'email-login',
      metadata: { email: emailValue, provider: 'email-password' },
    })
    // Invalid, inactive, and locked accounts deliberately receive the same response.
    return { message: genericLoginError }
  }

  redirect(destination)
}

export async function logoutAction(_formData: FormData): Promise<void> {
  const payload = await getPayload({ config })
  const cookieStore = await cookies()
  await revokeCurrentExternalSession(payload, cookieStore.get(EXTERNAL_SESSION_COOKIE)?.value)
  await logout({ config })

  // Expire the root-scoped cookie explicitly so logout is independent of the action URL.
  const authConfig = payload.collections.users.config.auth

  if (authConfig) {
    const payloadCookie = generateExpiredPayloadCookie({
      collectionAuthConfig: authConfig,
      cookiePrefix: payload.config.cookiePrefix,
      returnCookieAsObject: true,
    })
    cookieStore.set(payloadCookie.name, '', {
      domain: payloadCookie.domain,
      expires: payloadCookie.expires ? new Date(payloadCookie.expires) : new Date(0),
      httpOnly: payloadCookie.httpOnly,
      path: payloadCookie.path,
      sameSite: payloadCookie.sameSite?.toLowerCase() as 'lax' | 'none' | 'strict' | undefined,
      secure: payloadCookie.secure,
    })
  }

  cookieStore.set(EXTERNAL_SESSION_COOKIE, '', {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: '/',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })

  redirect('/login')
}
