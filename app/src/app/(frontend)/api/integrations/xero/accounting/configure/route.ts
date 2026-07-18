import { NextResponse } from 'next/server'

import { getAppSession } from '@/lib/member-app/session'
import {
  guardAccountingCommand,
  hasTrustedOrigin,
  isAllowedAccountingAdministrator,
  safeErrorCode,
  setReauthenticatedPayloadCookie,
  settingsURL,
} from '@/lib/xero/accounting/route-helpers'
import { configureAccountingOAuth, verifyAccountingPassword } from '@/lib/xero/accounting/service'

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
    const formData = await guardAccountingCommand(request, session, 'configure', [
      'clientID',
      'clientSecret',
      'password',
    ])
    const clientID = formData.get('clientID')
    const clientSecret = formData.get('clientSecret')
    const password = formData.get('password')
    const confirmedToken = await verifyAccountingPassword(
      session,
      typeof password === 'string' ? password : '',
    )
    await configureAccountingOAuth(session, {
      clientID: typeof clientID === 'string' ? clientID : '',
      clientSecret: typeof clientSecret === 'string' ? clientSecret : '',
    })

    const response = NextResponse.redirect(settingsURL({ configured: '1' }), 303)
    setReauthenticatedPayloadCookie(response, session, confirmedToken)
    return response
  } catch (error) {
    return NextResponse.redirect(settingsURL({ error: safeErrorCode(error) }), 303)
  }
}
