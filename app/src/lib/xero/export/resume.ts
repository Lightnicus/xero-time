import 'server-only'

import { XERO_RECONNECT_EXPORT_CODE } from '@/lib/xero/accounting/recovery'

import type { Payload } from 'payload'

type QueueTask = (args: {
  input: { exportID: string }
  meta?: Record<string, unknown>
  queue: string
  task: 'create-xero-invoice' | 'reconcile-xero-invoice'
}) => Promise<{ id: number | string }>

/**
 * Re-queues exports that were parked while the Xero connection needed reconnecting, so they run
 * straight away instead of waiting for their next periodic recheck. The workers' own claims stay
 * the only authority on whether an export actually runs, so an extra job is harmless.
 */
export async function resumeExportsAwaitingReconnect(payload: Payload): Promise<number> {
  const parked = await payload.find({
    collection: 'invoice-exports',
    depth: 0,
    limit: 100,
    overrideAccess: true,
    pagination: false,
    where: {
      and: [
        { lastErrorCode: { equals: XERO_RECONNECT_EXPORT_CODE } },
        { state: { in: ['retry-wait', 'reconciling'] } },
      ],
    },
  })

  const queue = payload.jobs.queue as unknown as QueueTask
  let resumed = 0
  for (const document of parked.docs) {
    const exportID = String(document.id)
    const task = document.state === 'reconciling' ? 'reconcile-xero-invoice' : 'create-xero-invoice'
    await payload.update({
      collection: 'invoice-exports',
      id: exportID,
      data: { nextAttemptAt: new Date().toISOString() },
      overrideAccess: true,
    })
    const job = await queue({
      input: { exportID },
      meta: { exportID, reason: 'xero-reconnected' },
      queue: 'xero',
      task,
    })
    await payload.update({
      collection: 'invoice-exports',
      id: exportID,
      data: { jobId: String(job.id) },
      overrideAccess: true,
    })
    resumed += 1
  }
  return resumed
}
