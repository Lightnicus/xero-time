import { type NextRequest, NextResponse } from 'next/server'

import { environment } from '@/lib/env'
import { getAppSession } from '@/lib/member-app/session'
import { refreshXeroReferenceData } from '@/lib/xero/accounting/reference-data'
import {
  clearAccountingFlowCookie,
  isAllowedAccountingAdministrator,
  safeErrorCode,
  selectionURL,
  settingsURL,
} from '@/lib/xero/accounting/route-helpers'
import {
  ACCOUNTING_FLOW_COOKIE,
  completeAccountingCallback,
  rejectAccountingCallback,
} from '@/lib/xero/accounting/service'

export const runtime = 'nodejs'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getAppSession()
  if (!isAllowedAccountingAdministrator(session)) {
    return NextResponse.redirect(
      new URL('/login?next=/app/settings/xero', environment.serverURL),
      303,
    )
  }

  const url = new URL(request.url)
  const state = url.searchParams.get('state') ?? ''
  const code = url.searchParams.get('code') ?? ''
  const providerError = url.searchParams.get('error')
  const browserBinding = request.cookies.get(ACCOUNTING_FLOW_COOKIE)?.value ?? ''

  try {
    if (providerError) {
      await rejectAccountingCallback(session, {
        browserBinding,
        failureCode: providerError === 'access_denied' ? 'authorization-denied' : 'provider-error',
        state,
      })
      const response = NextResponse.redirect(settingsURL({ error: 'authorization-denied' }), 303)
      clearAccountingFlowCookie(response)
      return response
    }

    const result = await completeAccountingCallback(session, { browserBinding, code, state })
    if (result.status === 'select-tenant' && result.flowID) {
      return NextResponse.redirect(selectionURL(result.flowID), 303)
    }

    try {
      await refreshXeroReferenceData(session)
    } catch {
      // The grant is already committed; the scheduled maintenance job safely retries reference data.
    }

    const response = NextResponse.redirect(settingsURL({ connected: '1' }), 303)
    clearAccountingFlowCookie(response)
    return response
  } catch (error) {
    const response = NextResponse.redirect(settingsURL({ error: safeErrorCode(error) }), 303)
    clearAccountingFlowCookie(response)
    return response
  }
}
