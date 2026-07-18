import { timingSafeEqual } from 'node:crypto'

import { createLocalReq, getPayload } from 'payload'

import { environment } from '@/lib/env'
import { logServerEvent } from '@/lib/observability/logger'
import { prepareXeroQueue } from '@/lib/xero/export/maintenance'
import config from '@/payload.config'

export const dynamic = 'force-dynamic'
export const maxDuration = 50

const authorized = (request: Request): boolean => {
  if (!environment.cronSecret) return false
  const expected = Buffer.from(`Bearer ${environment.cronSecret}`, 'utf8')
  const received = Buffer.from(request.headers.get('authorization') ?? '', 'utf8')
  return received.length === expected.length && timingSafeEqual(received, expected)
}

const json = (body: unknown, status: number): Response =>
  Response.json(body, { headers: { 'Cache-Control': 'no-store' }, status })

export async function GET(request: Request): Promise<Response> {
  if (!environment.cronSecret) return json({ error: 'Queue runner is not configured.' }, 503)
  if (!authorized(request)) return json({ error: 'Unauthorized.' }, 401)

  const payload = await getPayload({ config })
  const database = payload.db.connection.db
  if (!database) return json({ error: 'Database unavailable.' }, 503)
  const leaseID = crypto.randomUUID()
  const locks = database.collection('application_cron_locks')
  let acquired = false
  try {
    const lock = await locks.findOneAndUpdate(
      {
        _id: 'xero-queue-runner' as never,
        $or: [{ leaseExpiresAt: { $lte: new Date() } }, { leaseExpiresAt: { $exists: false } }],
      },
      {
        $set: {
          leaseExpiresAt: new Date(Date.now() + 55_000),
          leaseID,
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after', upsert: true },
    )
    acquired = lock?.leaseID === leaseID
  } catch {
    acquired = false
  }
  if (!acquired) return json({ state: 'already-running' }, 202)

  try {
    const req = await createLocalReq({}, payload)
    const preparation = await prepareXeroQueue(payload, req)
    if (preparation.state === 'processing-paused') return json(preparation, 200)
    await payload.jobs.run({
      limit: 5,
      overrideAccess: true,
      processingOrder: 'createdAt',
      queue: 'xero',
      req,
      sequential: true,
      silent: true,
    })
    logServerEvent(payload, 'info', 'xero.queue-run-complete', {
      dispatched: preparation.dispatched,
      recovered: preparation.recovered,
    })
    return json({ preparation, state: 'complete' }, 200)
  } finally {
    await locks.updateOne(
      { _id: 'xero-queue-runner' as never, leaseID },
      { $set: { leaseExpiresAt: new Date(0), updatedAt: new Date() } },
    )
  }
}

export const POST = GET
