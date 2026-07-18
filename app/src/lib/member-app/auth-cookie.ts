import 'server-only'

import { cookies } from 'next/headers'
import { generatePayloadCookie, type Payload } from 'payload'

export async function setPayloadSessionCookie(payload: Payload, token: string): Promise<void> {
  const authConfig = payload.collections.users.config.auth
  if (!authConfig) throw new Error('The user collection is not configured for authentication.')

  const payloadCookie = generatePayloadCookie({
    collectionAuthConfig: authConfig,
    cookiePrefix: payload.config.cookiePrefix,
    returnCookieAsObject: true,
    token,
  })
  const cookieStore = await cookies()
  cookieStore.set(payloadCookie.name, payloadCookie.value ?? '', {
    domain: payloadCookie.domain,
    expires: payloadCookie.expires ? new Date(payloadCookie.expires) : undefined,
    httpOnly: payloadCookie.httpOnly,
    path: payloadCookie.path,
    sameSite: payloadCookie.sameSite?.toLowerCase() as 'lax' | 'none' | 'strict' | undefined,
    secure: payloadCookie.secure,
  })
}
