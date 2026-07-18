import 'server-only'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createLocalReq, getPayload, type Payload, type PayloadRequest } from 'payload'
import { cache } from 'react'

import { isActiveUser } from '@/access/roles'
import type { User } from '@/payload-types'
import config from '@/payload.config'

export type AppSession = {
  payload: Payload
  req: PayloadRequest
  user: User
}

/**
 * Authenticates the HttpOnly Payload session cookie and builds a request object
 * that keeps collection and field access enabled for Local API calls.
 */
export const getAppSession = cache(async (): Promise<AppSession | null> => {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })

  // JWT authentication reloads the user, but account activity is an application rule.
  if (!isActiveUser(user)) return null

  const req = await createLocalReq({ user }, payload)

  return {
    payload,
    req,
    user: user as User,
  }
})

export async function requireAppSession(): Promise<AppSession> {
  const session = await getAppSession()

  if (!session) redirect('/login?next=/app')

  return session
}

export function canLogTime(user: Pick<User, 'active' | 'role'>): boolean {
  return user.active && (user.role === 'owner' || user.role === 'admin' || user.role === 'member')
}
