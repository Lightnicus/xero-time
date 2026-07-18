import { NextResponse } from 'next/server'

import { getAppSession } from '@/lib/member-app/session'
import {
  hasTrustedOrigin,
  guardAccountingCommand,
  isAllowedAccountingAdministrator,
  safeErrorCode,
  settingsURL,
} from '@/lib/xero/accounting/route-helpers'
import { checkAccountingConnectionHealth } from '@/lib/xero/accounting/service'

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
    await guardAccountingCommand(request, session, 'health')
    await checkAccountingConnectionHealth(session)
    return NextResponse.redirect(settingsURL({ checked: '1' }), 303)
  } catch (error) {
    return NextResponse.redirect(settingsURL({ error: safeErrorCode(error) }), 303)
  }
}
