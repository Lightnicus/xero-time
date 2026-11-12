import 'server-only'

import { NextResponse } from 'next/server'

import { environment } from '@/lib/env'
import type { AppSession } from '@/lib/member-app/session'
import { enforceRateLimit, rateLimitKey } from '@/lib/security/rate-limit'
import { parseBoundedFormData } from '@/lib/security/request-input'

import { ACCOUNTING_FLOW_COOKIE, ACCOUNTING_FLOW_MAX_AGE_SECONDS } from './service'

export const settingsURL = (params: Record<string, string> = {}): URL => {
  const url = new URL('/app/settings/xero', environment.serverURL)
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  return url
}

export const connectedSettingsURL = (
  referenceData: { capabilityAvailable: boolean } | { status: 'failed' },
): URL =>
  'status' in referenceData
    ? settingsURL({ connected: '1', references: referenceData.status })
    : settingsURL({
        capability: referenceData.capabilityAvailable ? 'yes' : 'no',
        connected: '1',
        references: '1',
      })

export const selectionURL = (flowID: string): URL => {
  const url = new URL('/app/settings/xero/select', environment.serverURL)
  url.searchParams.set('flow', flowID)
  return url
}

export const hasTrustedOrigin = (request: Request): boolean => {
  const origin = request.headers.get('origin')
  return origin === environment.serverURL
}

export const guardAccountingCommand = async (
  request: Request,
  session: AppSession,
  operation: string,
  allowedFields: readonly string[] = [],
): Promise<FormData> => {
  if (!/^[a-z0-9-]{1,50}$/.test(operation)) throw new Error('Invalid command guard operation.')
  await enforceRateLimit(session.payload, {
    key: rateLimitKey(request.headers, `${session.user.id}:${operation}`),
    limit: 20,
    scope: 'command.xero-accounting',
    windowMs: 15 * 60_000,
  })
  return parseBoundedFormData(request, allowedFields)
}

export const setAccountingFlowCookie = (response: NextResponse, value: string): void => {
  response.cookies.set(ACCOUNTING_FLOW_COOKIE, value, {
    httpOnly: true,
    maxAge: ACCOUNTING_FLOW_MAX_AGE_SECONDS,
    path: '/',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })
}

export const clearAccountingFlowCookie = (response: NextResponse): void => {
  response.cookies.set(ACCOUNTING_FLOW_COOKIE, '', {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: '/',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })
}

export const safeErrorCode = (error: unknown): string => {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[a-z0-9-]{1,100}$/.test(error.code)
  ) {
    return error.code
  }
  return 'operation-failed'
}
