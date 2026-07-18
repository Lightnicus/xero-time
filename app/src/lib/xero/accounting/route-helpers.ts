import 'server-only'

import { NextResponse } from 'next/server'
import { generatePayloadCookie } from 'payload'

import { hasActiveRole } from '@/access/roles'
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

export const selectionURL = (flowID: string): URL => {
  const url = new URL('/app/settings/xero/select', environment.serverURL)
  url.searchParams.set('flow', flowID)
  return url
}

export const isAllowedAccountingAdministrator = (
  session: AppSession | null,
): session is AppSession => Boolean(session && hasActiveRole(session.user, ['owner', 'admin']))

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

export const setReauthenticatedPayloadCookie = (
  response: NextResponse,
  session: AppSession,
  token: string,
): void => {
  const authConfig = session.payload.collections.users.config.auth
  if (!authConfig) return

  const payloadCookie = generatePayloadCookie({
    collectionAuthConfig: authConfig,
    cookiePrefix: session.payload.config.cookiePrefix,
    returnCookieAsObject: true,
    token,
  })

  response.cookies.set(payloadCookie.name, payloadCookie.value ?? '', {
    domain: payloadCookie.domain,
    expires: payloadCookie.expires ? new Date(payloadCookie.expires) : undefined,
    httpOnly: payloadCookie.httpOnly,
    path: payloadCookie.path,
    sameSite: payloadCookie.sameSite?.toLowerCase() as 'lax' | 'none' | 'strict' | undefined,
    secure: payloadCookie.secure,
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
