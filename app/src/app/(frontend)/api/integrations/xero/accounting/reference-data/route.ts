import { NextResponse } from 'next/server'

import { getAppSession } from '@/lib/member-app/session'
import { refreshXeroReferenceData } from '@/lib/xero/accounting/reference-data'
import {
  hasTrustedOrigin,
  guardAccountingCommand,
  isAllowedAccountingAdministrator,
  safeErrorCode,
  settingsURL,
} from '@/lib/xero/accounting/route-helpers'

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
    await guardAccountingCommand(request, session, 'reference-data')
    const result = await refreshXeroReferenceData(session)
    return NextResponse.redirect(
      settingsURL({ capability: result.capabilityAvailable ? 'yes' : 'no', references: '1' }),
      303,
    )
  } catch (error) {
    return NextResponse.redirect(settingsURL({ error: safeErrorCode(error) }), 303)
  }
}
