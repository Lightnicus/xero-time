import { type NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { getPayload } from 'payload'

import { environment } from '@/lib/env'
import { getAppSession } from '@/lib/member-app/session'
import { enforceRateLimit, rateLimitKey } from '@/lib/security/rate-limit'
import { enqueueStaleAccountingHealthCheck } from '@/lib/xero/accounting/health-scheduling'
import {
  clearIdentityFlowCookie,
  identityErrorCode,
  identityFailureURL,
  setExternalSessionCookie,
} from '@/lib/xero/identity/route-helpers'
import {
  completeIdentityCallback,
  IDENTITY_FLOW_COOKIE,
  rejectIdentityCallback,
} from '@/lib/xero/identity/service'
import config from '@/payload.config'

export const runtime = 'nodejs'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const payload = await getPayload({ config })
  const currentSession = await getAppSession()
  const incomingURL = new URL(request.url)
  const state = incomingURL.searchParams.get('state') ?? ''
  const providerError = incomingURL.searchParams.get('error')
  const browserBinding = request.cookies.get(IDENTITY_FLOW_COOKIE)?.value ?? ''

  try {
    await enforceRateLimit(payload, {
      key: rateLimitKey(request.headers, state.slice(0, 24)),
      limit: 30,
      scope: 'authentication.xero-callback',
      windowMs: 15 * 60_000,
    })
    if (providerError) {
      await rejectIdentityCallback(payload, { browserBinding, state })
      const denied = NextResponse.redirect(
        identityFailureURL(Boolean(currentSession), 'authorization-denied'),
        303,
      )
      clearIdentityFlowCookie(denied)
      return denied
    }

    const result = await completeIdentityCallback(payload, {
      browserBinding,
      callbackURL: incomingURL,
      currentSession,
      userAgent: request.headers.get('user-agent'),
    })
    const destination = new URL(result.destination, environment.serverURL)
    const response = NextResponse.redirect(destination, 303)
    setExternalSessionCookie(response, result.sessionToken)
    clearIdentityFlowCookie(response)
    after(async () => {
      try {
        await enqueueStaleAccountingHealthCheck(payload, result.user)
      } catch {
        // Identity login remains independent of accounting maintenance.
      }
    })
    return response
  } catch (error) {
    const response = NextResponse.redirect(
      identityFailureURL(Boolean(currentSession), identityErrorCode(error)),
      303,
    )
    clearIdentityFlowCookie(response)
    return response
  }
}
