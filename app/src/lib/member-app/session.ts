import 'server-only'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import {
  createLocalReq,
  getPayload,
  parseCookies,
  type Payload,
  type PayloadRequest,
} from 'payload'
import { cache } from 'react'

import { isActiveUser } from '@/access/roles'
import type { User } from '@/payload-types'
import config from '@/payload.config'

export type AppSession = {
  payload: Payload
  req: PayloadRequest
  user: User
}

const appSessionFromHeaders = async (
  requestHeaders: Headers,
  existingPayload?: Payload,
): Promise<AppSession | null> => {
  const payload = existingPayload ?? (await getPayload({ config }))
  const { user } = await payload.auth({ headers: requestHeaders })

  // JWT authentication reloads the user, but account activity is an application rule.
  if (!isActiveUser(user)) return null

  const req = await createLocalReq({ user }, payload)

  return {
    payload,
    req,
    user: user as User,
  }
}

/**
 * Authenticates the HttpOnly Payload session cookie and builds a request object
 * that keeps collection and field access enabled for Local API calls.
 */
export const getAppSession = cache(async (): Promise<AppSession | null> =>
  appSessionFromHeaders(await headers()),
)

/**
 * Payload deliberately ignores JWT cookies on cross-site requests. An OAuth
 * start route writes a fresh local JWT after password confirmation, so recover
 * only that signed token on the provider callback. Caller authorization,
 * origin, fetch metadata, and unrelated cookies are intentionally discarded;
 * the callback route still validates one-time state and browser binding.
 */
export async function getAppSessionForOAuthCallback(
  requestHeaders: Headers,
): Promise<AppSession | null> {
  const payload = await getPayload({ config })
  const token = parseCookies(requestHeaders).get(`${payload.config.cookiePrefix}-token`)
  if (
    !token ||
    token.length > 20_000 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  ) {
    return null
  }

  const callbackHeaders = new Headers({
    Authorization: `JWT ${token}`,
    DisableAutologin: 'true',
  })
  return appSessionFromHeaders(callbackHeaders, payload)
}

export async function requireAppSession(): Promise<AppSession> {
  const session = await getAppSession()

  if (!session) redirect('/login?next=/app')

  return session
}

export function canLogTime(user: Pick<User, 'active' | 'role'>): boolean {
  return user.active && (user.role === 'owner' || user.role === 'admin' || user.role === 'member')
}
