import { NextResponse } from 'next/server'

import { getAppSession } from '@/lib/member-app/session'
import {
  guardAccountingCommand,
  hasTrustedOrigin,
  safeErrorCode,
  setAccountingFlowCookie,
  settingsURL,
} from '@/lib/xero/accounting/route-helpers'
import { createAccountingAuthorization } from '@/lib/xero/accounting/service'

export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  if (!hasTrustedOrigin(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const session = await getAppSession()
  if (!session) return NextResponse.redirect(settingsURL({ error: 'forbidden' }), 303)

  try {
    await guardAccountingCommand(request, session, 'start')
    // Whoever signs in to Xero authorizes the connection; reconnecting as a different Xero user
    // is fine as long as it is the same organisation.
    const authorization = await createAccountingAuthorization(session)
    const response = NextResponse.redirect(authorization.authorizationURL, 303)
    setAccountingFlowCookie(response, authorization.browserBinding)
    return response
  } catch (error) {
    return NextResponse.redirect(settingsURL({ error: safeErrorCode(error) }), 303)
  }
}
