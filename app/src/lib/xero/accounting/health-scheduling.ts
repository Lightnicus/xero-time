import 'server-only'

import { createLocalReq, type Payload } from 'payload'

import { requireMongoModel } from '@/lib/payload/mongo'
import type { User } from '@/payload-types'

type QueueMaintenance = (args: {
  input: { reason: string }
  meta: Record<string, unknown>
  queue: 'xero'
  req: Awaited<ReturnType<typeof createLocalReq>>
  task: 'maintain-xero-accounting'
}) => Promise<unknown>

/** Queues only a deduplicated health job; it never receives or opens an identity credential. */
export async function enqueueStaleAccountingHealthCheck(
  payload: Payload,
  user: User,
): Promise<boolean> {
  const [settings, connections] = await Promise.all([
    payload.findGlobal({ slug: 'authentication-settings', overrideAccess: true }),
    payload.find({
      collection: 'xero-connections',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { singletonKey: { equals: 'business-accounting' } },
    }),
  ])
  const connection = connections.docs[0]
  if (!connection || connection.status !== 'connected') return false
  const lastCheck = Date.parse(connection.lastHealthCheckAt ?? connection.lastRefreshedAt ?? '')
  const staleAfter = settings.staleAccountingHealthCheckHours * 60 * 60 * 1_000
  if (Number.isFinite(lastCheck) && lastCheck > Date.now() - staleAfter) return false

  const pending = await requireMongoModel(payload, 'payload-jobs').findOne({
    completedAt: { $in: [null, undefined] },
    queue: 'xero',
    taskSlug: 'maintain-xero-accounting',
  })
  if (pending) return false
  const req = await createLocalReq({ user }, payload)
  await (payload.jobs.queue as unknown as QueueMaintenance)({
    input: { reason: 'stale-after-application-login' },
    meta: { maintenanceKey: 'login-stale' },
    queue: 'xero',
    req,
    task: 'maintain-xero-accounting',
  })
  return true
}
