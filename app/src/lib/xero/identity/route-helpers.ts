import 'server-only'

import { NextResponse } from 'next/server'
import { generatePayloadCookie } from 'payload'

import { environment } from '@/lib/env'
import type { AppSession } from '@/lib/member-app/session'

import {
  EXTERNAL_SESSION_COOKIE,
  IDENTITY_FLOW_COOKIE,
  IDENTITY_FLOW_MAX_AGE_SECONDS,
} from './constants'

export const hasTrustedIdentityOrigin = (request: Request): boolean =>
  request.headers.get('origin') === environment.serverURL

export const setIdentityFlowCookie = (response: NextResponse, value: string): void => {
  response.cookies.set(IDENTITY_FLOW_COOKIE, value, {
    httpOnly: true,
    maxAge: IDENTITY_FLOW_MAX_AGE_SECONDS,
    path: '/',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })
}

export const clearIdentityFlowCookie = (response: NextResponse): void => {
  response.cookies.set(IDENTITY_FLOW_COOKIE, '', {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: '/',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })
}

export const setExternalSessionCookie = (response: NextResponse, token: string): void => {
  response.cookies.set(EXTERNAL_SESSION_COOKIE, token, {
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60,
    path: '/',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })
}

export const clearExternalSessionCookie = (response: NextResponse): void => {
  response.cookies.set(EXTERNAL_SESSION_COOKIE, '', {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: '/',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })
}

export const setReauthenticatedIdentityCookie = (
  response: NextResponse,
  session: AppSession,
  token: string,
): void => {
  const authConfig = session.payload.collections.users.config.auth
  if (!authConfig) return
  const cookie = generatePayloadCookie({
    collectionAuthConfig: authConfig,
    cookiePrefix: session.payload.config.cookiePrefix,
    returnCookieAsObject: true,
    token,
  })
  response.cookies.set(cookie.name, cookie.value ?? '', {
    domain: cookie.domain,
    expires: cookie.expires ? new Date(cookie.expires) : undefined,
    httpOnly: cookie.httpOnly,
    path: cookie.path,
    sameSite: cookie.sameSite?.toLowerCase() as 'lax' | 'none' | 'strict' | undefined,
    secure: cookie.secure,
  })
}

export const identityErrorCode = (error: unknown): string => {
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

export const identityFailureURL = (authenticated: boolean, code: string): URL => {
  const url = new URL(authenticated ? '/app/profile' : '/login', environment.serverURL)
  url.searchParams.set('xero', code)
  return url
}
