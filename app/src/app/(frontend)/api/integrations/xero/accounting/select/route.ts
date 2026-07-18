import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

import { getAppSession } from '@/lib/member-app/session'
import {
  clearAccountingFlowCookie,
  guardAccountingCommand,
  hasTrustedOrigin,
  isAllowedAccountingAdministrator,
  safeErrorCode,
  settingsURL,
} from '@/lib/xero/accounting/route-helpers'
import { ACCOUNTING_FLOW_COOKIE, selectAccountingTenant } from '@/lib/xero/accounting/service'

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
    const formData = await guardAccountingCommand(request, session, 'select-tenant', [
      'flowID',
      'tenantID',
    ])
    const flowID = formData.get('flowID')
    const tenantID = formData.get('tenantID')
    const browserBinding = (await cookies()).get(ACCOUNTING_FLOW_COOKIE)?.value ?? ''
    await selectAccountingTenant(session, {
      browserBinding,
      flowID: typeof flowID === 'string' ? flowID : '',
      tenantID: typeof tenantID === 'string' ? tenantID : '',
    })
    const response = NextResponse.redirect(settingsURL({ connected: '1' }), 303)
    clearAccountingFlowCookie(response)
    return response
  } catch (error) {
    const response = NextResponse.redirect(settingsURL({ error: safeErrorCode(error) }), 303)
    clearAccountingFlowCookie(response)
    return response
  }
}
