import { NextResponse } from 'next/server'
import { getPayload } from 'payload'

import { environment } from '@/lib/env'
import { getAppSession } from '@/lib/member-app/session'
import { enforceRateLimit, rateLimitKey } from '@/lib/security/rate-limit'
import { parseBoundedFormData } from '@/lib/security/request-input'
import {
  hasTrustedIdentityOrigin,
  identityErrorCode,
  identityFailureURL,
  setIdentityFlowCookie,
  setReauthenticatedIdentityCookie,
} from '@/lib/xero/identity/route-helpers'
import {
  confirmIdentityLinkPassword,
  createIdentityAuthorization,
  type IdentityFlowPurpose,
} from '@/lib/xero/identity/service'
import config from '@/payload.config'

export const runtime = 'nodejs'

const purposes = new Set<IdentityFlowPurpose>(['sign-in', 'invite-acceptance', 'identity-link'])

export async function POST(request: Request): Promise<NextResponse> {
  if (!hasTrustedIdentityOrigin(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  let formData: FormData
  try {
    formData = await parseBoundedFormData(request, [
      'invitationToken',
      'password',
      'purpose',
      'returnPath',
    ])
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
  const purposeValue = formData.get('purpose')
  const purpose =
    typeof purposeValue === 'string' && purposes.has(purposeValue as IdentityFlowPurpose)
      ? (purposeValue as IdentityFlowPurpose)
      : null
  const currentSession = await getAppSession()
  if (!purpose) {
    return NextResponse.redirect(
      identityFailureURL(Boolean(currentSession), 'invalid-request'),
      303,
    )
  }

  try {
    const payload = await getPayload({ config })
    await enforceRateLimit(payload, {
      key: rateLimitKey(request.headers, purpose),
      limit: 20,
      scope: 'authentication.xero-start',
      windowMs: 15 * 60_000,
    })
    let confirmedToken: string | null = null
    if (purpose === 'identity-link') {
      if (!currentSession) {
        return NextResponse.redirect(
          new URL('/login?next=/app/profile', environment.serverURL),
          303,
        )
      }
      const password = formData.get('password')
      confirmedToken = await confirmIdentityLinkPassword(
        currentSession,
        typeof password === 'string' ? password : '',
      )
    }

    const invitationToken = formData.get('invitationToken')
    const returnPath = formData.get('returnPath')
    const authorization = await createIdentityAuthorization(payload, {
      invitationToken: typeof invitationToken === 'string' ? invitationToken : undefined,
      purpose,
      recentlyReauthenticated: Boolean(confirmedToken),
      returnPath: typeof returnPath === 'string' ? returnPath : undefined,
      session: currentSession,
    })
    const response = NextResponse.redirect(authorization.authorizationURL, 303)
    setIdentityFlowCookie(response, authorization.browserBinding)
    if (confirmedToken && currentSession) {
      setReauthenticatedIdentityCookie(response, currentSession, confirmedToken)
    }
    return response
  } catch (error) {
    return NextResponse.redirect(
      identityFailureURL(Boolean(currentSession), identityErrorCode(error)),
      303,
    )
  }
}
