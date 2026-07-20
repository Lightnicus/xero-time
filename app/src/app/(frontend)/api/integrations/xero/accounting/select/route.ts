import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

import { getAppSession } from '@/lib/member-app/session'
import { refreshXeroReferenceData } from '@/lib/xero/accounting/reference-data'
import {
  clearAccountingFlowCookie,
  connectedSettingsURL,
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
    let completionURL: URL
    try {
      completionURL = connectedSettingsURL(await refreshXeroReferenceData(session))
    } catch {
      // Tenant validation and connection persistence have completed. Preserve
      // that grant, but make the incomplete reference-data setup explicit.
      completionURL = connectedSettingsURL({ status: 'failed' })
    }
    const response = NextResponse.redirect(completionURL, 303)
    clearAccountingFlowCookie(response)
    return response
  } catch (error) {
    const response = NextResponse.redirect(settingsURL({ error: safeErrorCode(error) }), 303)
    clearAccountingFlowCookie(response)
    return response
  }
}
