import 'server-only'

import type { PayloadRequest } from 'payload'

export const LOCAL_API_ELEVATION_CONTEXT = 'localApiElevationReason'

export const userLocalOptions = (req: PayloadRequest) => ({ overrideAccess: false as const, req })

export async function withElevatedLocalOptions<T>(
  req: PayloadRequest,
  reason: string,
  operation: (options: { overrideAccess: true; req: PayloadRequest }) => Promise<T>,
): Promise<T> {
  const normalizedReason = reason.trim()
  if (normalizedReason.length < 10 || normalizedReason.length > 200) {
    throw new Error('Local API elevation requires a reason from 10 to 200 characters.')
  }
  const previousContext = req.context
  req.context = {
    ...(req.context ?? {}),
    [LOCAL_API_ELEVATION_CONTEXT]: normalizedReason,
  }
  try {
    return await operation({ overrideAccess: true, req })
  } finally {
    req.context = previousContext ?? {}
  }
}
