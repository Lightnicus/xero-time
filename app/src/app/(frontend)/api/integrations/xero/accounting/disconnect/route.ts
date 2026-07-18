import { NextResponse } from 'next/server'

import { getAppSession } from '@/lib/member-app/session'
import {
  clearAccountingFlowCookie,
  guardAccountingCommand,
  hasTrustedOrigin,
  isAllowedAccountingAdministrator,
  safeErrorCode,
  setReauthenticatedPayloadCookie,
  settingsURL,
} from '@/lib/xero/accounting/route-helpers'
import {
  disconnectAccountingConnection,
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
    const formData = await guardAccountingCommand(request, session, 'disconnect', [
      'confirmation',
      'password',
      'reason',
    ])
    const password = formData.get('password')
    const reason = formData.get('reason')
    const confirmation = formData.get('confirmation')
    if (confirmation !== 'disconnect') throw new Error('Disconnect was not confirmed.')

    const confirmedToken = await verifyAccountingPassword(
      session,
      typeof password === 'string' ? password : '',
    )
    const result = await disconnectAccountingConnection(
      session,
      typeof reason === 'string' ? reason : '',
    )
    const response = NextResponse.redirect(
      settingsURL({
        disconnected: '1',
        remote: result.remoteCleanupComplete ? 'complete' : 'check',
      }),
      303,
    )
    clearAccountingFlowCookie(response)
    setReauthenticatedPayloadCookie(response, session, confirmedToken)
    return response
  } catch (error) {
    return NextResponse.redirect(settingsURL({ error: safeErrorCode(error) }), 303)
  }
}
