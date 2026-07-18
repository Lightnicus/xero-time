import { NextResponse } from 'next/server'

import { getAppSession } from '@/lib/member-app/session'
import {
  hasTrustedOrigin,
  guardAccountingCommand,
  isAllowedAccountingAdministrator,
  safeErrorCode,
  setAccountingFlowCookie,
  setReauthenticatedPayloadCookie,
  settingsURL,
} from '@/lib/xero/accounting/route-helpers'
import {
  createAccountingAuthorization,
  verifyAccountingPassword,
} from '@/lib/xero/accounting/service'

export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  if (!hasTrustedOrigin(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const session = await getAppSession()
  if (!isAllowedAccountingAdministrator(session)) {
    return NextResponse.redirect(settingsURL({ error: 'forbidden' }), 303)
  }

  try {
    const formData = await guardAccountingCommand(request, session, 'start', ['password'])
    const password = formData.get('password')
    const confirmedToken = await verifyAccountingPassword(
      session,
      typeof password === 'string' ? password : '',
    )
    const authorization = await createAccountingAuthorization(session)
    const response = NextResponse.redirect(authorization.authorizationURL, 303)
    setAccountingFlowCookie(response, authorization.browserBinding)
    setReauthenticatedPayloadCookie(response, session, confirmedToken)
    return response
  } catch (error) {
    return NextResponse.redirect(settingsURL({ error: safeErrorCode(error) }), 303)
  }
}
