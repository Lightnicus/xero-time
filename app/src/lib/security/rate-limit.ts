import 'server-only'

import { createHash } from 'node:crypto'

import type { Payload } from 'payload'

export class RateLimitError extends Error {
  retryAfterSeconds: number

  constructor(retryAfterSeconds: number) {
    super('Too many requests. Try again later.')
    this.name = 'RateLimitError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

const safeForwardedAddress = (headers: Headers): string => {
  const candidate =
    headers.get('x-vercel-forwarded-for') ??
    headers.get('x-forwarded-for')?.split(',')[0] ??
    headers.get('x-real-ip') ??
    'unknown'
  const normalized = candidate.trim().slice(0, 100)
  return /^[0-9a-f:.]+$/i.test(normalized) ? normalized : 'unknown'
}

export const rateLimitKey = (headers: Headers, identifier = ''): string =>
  `${safeForwardedAddress(headers)}:${identifier.trim().toLowerCase().slice(0, 320)}`

export async function enforceRateLimit(
  payload: Payload,
  input: {
    key: string
    limit: number
    now?: Date
    scope: string
    windowMs: number
  },
): Promise<void> {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    !Number.isSafeInteger(input.windowMs) ||
    input.windowMs < 1_000 ||
    !/^[a-z0-9.-]{1,100}$/.test(input.scope)
  ) {
    throw new Error('Invalid rate-limit configuration.')
  }
  const database = payload.db.connection.db
  if (!database) throw new Error('MongoDB is unavailable for rate limiting.')

  const now = input.now ?? new Date()
  const bucket = Math.floor(now.getTime() / input.windowMs)
  const id = createHash('sha256')
    .update(`${input.scope}:${input.key}:${bucket}`, 'utf8')
    .digest('base64url')
  const bucketEndsAt = new Date((bucket + 1) * input.windowMs)
  const collection = database.collection<{
    _id: string
    cleanupAt: Date
    count: number
    scope: string
  }>('application_rate_limits')
  const record = await collection.findOneAndUpdate(
    { _id: id },
    {
      $inc: { count: 1 },
      $setOnInsert: {
        cleanupAt: new Date(bucketEndsAt.getTime() + input.windowMs),
        scope: input.scope,
      },
    },
    { returnDocument: 'after', upsert: true },
  )
  if ((record?.count ?? input.limit + 1) > input.limit) {
    throw new RateLimitError(
      Math.max(1, Math.ceil((bucketEndsAt.getTime() - now.getTime()) / 1_000)),
    )
  }
}
