'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'

import { enforceRateLimit, rateLimitKey } from '@/lib/security/rate-limit'
import config from '@/payload.config'

export async function verifyEmailAction(formData: FormData): Promise<void> {
  const token = formData.get('token')
  if (typeof token !== 'string' || token.length === 0 || token.length > 1_000) {
    redirect('/verify-email?status=invalid')
  }
  try {
    const payload = await getPayload({ config })
    await enforceRateLimit(payload, {
      key: rateLimitKey(await headers(), token.slice(0, 32)),
      limit: 10,
      scope: 'authentication.email-verification',
      windowMs: 30 * 60_000,
    })
    await payload.verifyEmail({ collection: 'users', token })
  } catch {
    redirect('/verify-email?status=invalid')
  }
  redirect('/login?verified=1')
}
