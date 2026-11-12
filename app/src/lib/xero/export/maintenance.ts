import 'server-only'

import { dispatchPreparingExports } from '@/lib/billing/dispatch'
import { requireMongoModel } from '@/lib/payload/mongo'
import { refreshXeroReferenceData } from '@/lib/xero/accounting/reference-data'
import {
  checkAccountingConnectionHealth,
  createAccountingSystemSession,
} from '@/lib/xero/accounting/service'

import type { Payload, PayloadRequest } from 'payload'

type QueueTask = (args: {
  input: Record<string, string>
  meta?: Record<string, unknown>
  queue: string
  task:
    | 'create-xero-invoice'
    | 'maintain-xero-accounting'
    | 'process-xero-webhook-receipt'
    | 'reconcile-xero-invoice'
    | 'refresh-xero-invoice-status'
}) => Promise<{ id: number | string }>

const queue = (payload: Payload): QueueTask => payload.jobs.queue as unknown as QueueTask

/** A receipt that keeps failing stops being retried; it stays visible as failed for review. */
const MAX_WEBHOOK_RECEIPT_RETRIES = 10

/**
 * Finds a queued or running job by its input. Job `meta` is not persisted unless Payload's job
 * stats are enabled, so deduplication has to use the task input. Jobs that exhausted their
 * retries keep `completedAt` empty but set `hasError`, and must not block rescheduling.
 */
const hasPendingJob = async (
  payload: Payload,
  taskSlug: string,
  input?: { field: string; value: string },
): Promise<boolean> => {
  const query: Record<string, unknown> = {
    completedAt: { $in: [null, undefined] },
    hasError: { $ne: true },
    taskSlug,
  }
  if (input) query[`input.${input.field}`] = input.value
  return Boolean(await requireMongoModel(payload, 'payload-jobs').findOne(query))
}

/** Queue runs are capped well below this, so a job still "processing" after it has stalled. */
export const STALLED_JOB_MS = 10 * 60 * 1_000

/**
 * Payload never clears `processing` on a job whose worker died (for example a function timeout),
 * and every Xero job shares one concurrency key, so one stalled job would block the whole queue.
 * Fail such jobs; the export's own lease recovery then retries or reconciles it safely.
 */
export const releaseStalledJobs = async (payload: Payload): Promise<number> => {
  const result = await requireMongoModel(payload, 'payload-jobs').updateMany(
    {
      completedAt: { $in: [null, undefined] },
      processing: true,
      queue: 'xero',
      updatedAt: { $lt: new Date(Date.now() - STALLED_JOB_MS) },
    },
    {
      $set: {
        error: { message: 'The worker stopped before finishing; the job was released.' },
        hasError: true,
        processing: false,
        updatedAt: new Date(),
      },
    },
  )
  return result.modifiedCount
}

const recoverStaleExports = async (payload: Payload, req: PayloadRequest): Promise<number> => {
  const stale = await payload.find({
    collection: 'invoice-exports',
    depth: 0,
    limit: 25,
    overrideAccess: true,
    req,
    where: {
      and: [
        { state: { equals: 'processing' } },
        { processingLeaseExpiresAt: { less_than_equal: new Date().toISOString() } },
      ],
    },
  })
  let recovered = 0
  for (const document of stale.docs) {
    const attemptID =
      typeof document.currentAttempt === 'object' && document.currentAttempt
        ? String(document.currentAttempt.id)
        : document.currentAttempt
          ? String(document.currentAttempt)
          : null
    const attempt = attemptID
      ? await payload.findByID({
          collection: 'xero-attempts',
          depth: 0,
          id: attemptID,
          overrideAccess: true,
          req,
          showHiddenFields: true,
        })
      : null
    if (attempt?.requestMayHaveBeenSent) {
      await payload.update({
        collection: 'invoice-exports',
        id: document.id,
        data: {
          lastErrorCode: 'stale-worker-ambiguous',
          lastErrorMessage:
            'A worker lease expired after the request may have been sent; reconciliation is required.',
          processingLeaseExpiresAt: null,
          processingLeaseId: null,
          state: 'reconciling',
        },
        overrideAccess: true,
        req,
      })
      if (
        !(await hasPendingJob(payload, 'reconcile-xero-invoice', {
          field: 'exportID',
          value: String(document.id),
        }))
      ) {
        const job = await queue(payload)({
          input: { exportID: String(document.id) },
          meta: { exportID: String(document.id), reason: 'stale-worker' },
          queue: 'xero',
          task: 'reconcile-xero-invoice',
        })
        await payload.update({
          collection: 'invoice-exports',
          id: document.id,
          data: { jobId: String(job.id) },
          overrideAccess: true,
          req,
        })
      }
    } else {
      await payload.update({
        collection: 'invoice-exports',
        id: document.id,
        data: {
          dispatchState: 'pending',
          jobId: null,
          lastErrorCode: 'stale-worker-before-send',
          lastErrorMessage:
            'A worker lease expired before a request was sent; the durable dispatcher will retry it.',
          processingLeaseExpiresAt: null,
          processingLeaseId: null,
          state: 'preparing',
        },
        overrideAccess: true,
        req,
      })
    }
    recovered += 1
  }
  return recovered
}

/**
 * Re-queues exports that are waiting to retry or reconcile but have no job left to run them, for
 * example because a job failed outside its own error handling or returned early while processing
 * was paused. The workers' claims still decide whether anything actually runs.
 */
const requeueOrphanedExports = async (payload: Payload, req: PayloadRequest): Promise<number> => {
  const overdue = new Date(Date.now() - 2 * 60_000).toISOString()
  const waiting = await payload.find({
    collection: 'invoice-exports',
    depth: 0,
    limit: 25,
    overrideAccess: true,
    req,
    sort: 'nextAttemptAt',
    where: {
      and: [
        { state: { in: ['retry-wait', 'reconciling'] } },
        {
          or: [
            { nextAttemptAt: { less_than_equal: overdue } },
            {
              and: [
                { nextAttemptAt: { exists: false } },
                { updatedAt: { less_than_equal: overdue } },
              ],
            },
          ],
        },
        {
          or: [
            { processingLeaseExpiresAt: { exists: false } },
            { processingLeaseExpiresAt: { less_than_equal: new Date().toISOString() } },
          ],
        },
      ],
    },
  })
  let requeued = 0
  for (const document of waiting.docs) {
    const exportID = String(document.id)
    const task = document.state === 'reconciling' ? 'reconcile-xero-invoice' : 'create-xero-invoice'
    if (await hasPendingJob(payload, task, { field: 'exportID', value: exportID })) continue
    const job = await queue(payload)({
      input: { exportID },
      meta: { exportID, reason: 'orphaned-export-sweeper' },
      queue: 'xero',
      task,
    })
    await payload.update({
      collection: 'invoice-exports',
      id: exportID,
      data: { jobId: String(job.id) },
      overrideAccess: true,
      req,
    })
    requeued += 1
  }
  return requeued
}

const schedulePendingWebhookReceipts = async (
  payload: Payload,
  req: PayloadRequest,
): Promise<number> => {
  const receipts = await payload.find({
    collection: 'xero-webhook-receipts',
    depth: 0,
    limit: 25,
    overrideAccess: true,
    req,
    where: {
      and: [
        { status: { in: ['pending', 'failed'] } },
        { or: [{ jobId: { exists: false } }, { jobId: { equals: null } }] },
        {
          or: [
            { retryCount: { exists: false } },
            { retryCount: { less_than: MAX_WEBHOOK_RECEIPT_RETRIES } },
          ],
        },
      ],
    },
  })
  for (const receipt of receipts.docs) {
    const job = await queue(payload)({
      input: { receiptID: String(receipt.id) },
      meta: { receiptID: String(receipt.id), reason: 'receipt-sweeper' },
      queue: 'xero',
      task: 'process-xero-webhook-receipt',
    })
    await payload.update({
      collection: 'xero-webhook-receipts',
      id: receipt.id,
      data: { jobId: String(job.id) },
      overrideAccess: true,
      req,
    })
  }
  return receipts.docs.length
}

const scheduleStatusRefresh = async (payload: Payload, req: PayloadRequest): Promise<number> => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString()
  const exports = await payload.find({
    collection: 'invoice-exports',
    depth: 0,
    limit: 5,
    overrideAccess: true,
    req,
    sort: 'lastReconciledAt',
    where: {
      and: [
        { state: { in: ['succeeded', 'action-required', 'released'] } },
        { xeroInvoiceId: { exists: true } },
        {
          or: [
            { lastReconciledAt: { exists: false } },
            { lastReconciledAt: { less_than_equal: cutoff } },
          ],
        },
      ],
    },
  })
  let queued = 0
  for (const document of exports.docs) {
    if (
      await hasPendingJob(payload, 'refresh-xero-invoice-status', {
        field: 'exportID',
        value: String(document.id),
      })
    )
      continue
    await queue(payload)({
      input: { exportID: String(document.id) },
      meta: { exportID: String(document.id), reason: 'scheduled-status-refresh' },
      queue: 'xero',
      task: 'refresh-xero-invoice-status',
    })
    queued += 1
  }
  return queued
}

const HEALTH_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000

/** The connected business connection when its daily health check is due, otherwise null. */
const connectionDueForHealthCheck = async (payload: Payload, req: PayloadRequest) => {
  const connections = await payload.find({
    collection: 'xero-connections',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { singletonKey: { equals: 'business-accounting' } },
  })
  const connection = connections.docs[0]
  if (!connection || connection.status !== 'connected') return null
  const last = Date.parse(connection.lastHealthCheckAt ?? connection.lastRefreshedAt ?? '')
  if (Number.isFinite(last) && last > Date.now() - HEALTH_CHECK_INTERVAL_MS) return null
  return connection
}

/**
 * While processing is paused the queue does not run, but Xero's refresh token still expires after
 * 60 days without use. Check the connection directly so a long pause never forces a reconnect.
 * A failure marks the connection as needing reconnection (and emails the user) as usual.
 */
export const checkConnectionWhilePaused = async (
  payload: Payload,
  req: PayloadRequest,
): Promise<number> => {
  if (!(await connectionDueForHealthCheck(payload, req))) return 0
  try {
    await checkAccountingConnectionHealth(await createAccountingSystemSession(payload))
  } catch {
    // The connection records its own failure state; the next cron run retries when still due.
  }
  return 1
}

const scheduleConnectionMaintenance = async (
  payload: Payload,
  req: PayloadRequest,
): Promise<number> => {
  if (!(await connectionDueForHealthCheck(payload, req))) return 0
  if (await hasPendingJob(payload, 'maintain-xero-accounting')) return 0
  await queue(payload)({
    input: { reason: 'scheduled-daily' },
    meta: { maintenanceKey: 'daily' },
    queue: 'xero',
    task: 'maintain-xero-accounting',
  })
  return 1
}

export async function maintainXeroAccountingConnection(
  req: PayloadRequest,
  _reason: string,
): Promise<{ state: string }> {
  const session = await createAccountingSystemSession(req.payload)
  await checkAccountingConnectionHealth(session)
  await refreshXeroReferenceData(session, { machineActor: 'xero-maintenance-worker' })
  return { state: 'healthy' }
}

export async function prepareXeroQueue(
  payload: Payload,
  req: PayloadRequest,
): Promise<Record<string, number | string>> {
  const settings = await payload.findGlobal({
    slug: 'billing-settings',
    depth: 0,
    overrideAccess: true,
    req,
  })
  if (settings.processingEnabled !== true) {
    return {
      healthChecks: await checkConnectionWhilePaused(payload, req),
      state: 'processing-paused',
    }
  }
  const stalledJobs = await releaseStalledJobs(payload)
  const recovered = await recoverStaleExports(payload, req)
  const requeued = await requeueOrphanedExports(payload, req)
  const dispatched = await dispatchPreparingExports(payload, req)
  const webhookReceipts = await schedulePendingWebhookReceipts(payload, req)
  const statusRefreshes = await scheduleStatusRefresh(payload, req)
  const maintenanceJobs = await scheduleConnectionMaintenance(payload, req)
  return {
    dispatched: dispatched.dispatched,
    dispatchErrors: dispatched.errors,
    maintenanceJobs,
    recovered,
    requeued,
    stalledJobs,
    state: 'ready',
    statusRefreshes,
    webhookReceipts,
  }
}
