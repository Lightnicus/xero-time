import { NextResponse } from 'next/server'

import { getAppSession } from '@/lib/member-app/session'
import {
  clearAccountingFlowCookie,
  guardAccountingCommand,
  hasTrustedOrigin,
  safeErrorCode,
  settingsURL,
} from '@/lib/xero/accounting/route-helpers'
import { disconnectAccountingConnection } from '@/lib/xero/accounting/service'

export const runtime = 'nodejs'

export async function POST(request: Request): Promise<NextResponse> {
  if (!hasTrustedOrigin(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const session = await getAppSession()
  if (!session) return NextResponse.redirect(settingsURL({ error: 'forbidden' }), 303)

  try {
    const formData = await guardAccountingCommand(request, session, 'disconnect', [
      'confirmation',
      'reason',
    ])
    if (formData.get('confirmation') !== 'disconnect') {
      throw new Error('Disconnect was not confirmed.')
    }
    const reason = formData.get('reason')
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
    return response
  } catch (error) {
    return NextResponse.redirect(settingsURL({ error: safeErrorCode(error) }), 303)
  }
}
