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
    | 'maintain-xero-accounting'
    | 'process-xero-webhook-receipt'
    | 'reconcile-xero-invoice'
    | 'refresh-xero-invoice-status'
}) => Promise<{ id: number | string }>

const queue = (payload: Payload): QueueTask => payload.jobs.queue as unknown as QueueTask

const hasPendingJob = async (
  payload: Payload,
  metadataField: string,
  value: string,
  taskSlug?: string,
): Promise<boolean> => {
  const query: Record<string, unknown> = {
    completedAt: { $in: [null, undefined] },
    [`meta.${metadataField}`]: value,
  }
  if (taskSlug) query.taskSlug = taskSlug
  return Boolean(await requireMongoModel(payload, 'payload-jobs').findOne(query))
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
        !(await hasPendingJob(payload, 'exportID', String(document.id), 'reconcile-xero-invoice'))
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
      await hasPendingJob(payload, 'exportID', String(document.id), 'refresh-xero-invoice-status')
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

const scheduleConnectionMaintenance = async (
  payload: Payload,
  req: PayloadRequest,
): Promise<number> => {
  const connections = await payload.find({
    collection: 'xero-connections',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { singletonKey: { equals: 'business-accounting' } },
  })
  const connection = connections.docs[0]
  if (!connection || connection.status !== 'connected') return 0
  const last = Date.parse(connection.lastHealthCheckAt ?? connection.lastRefreshedAt ?? '')
  if (Number.isFinite(last) && last > Date.now() - 24 * 60 * 60 * 1_000) return 0
  if (await hasPendingJob(payload, 'maintenanceKey', 'daily', 'maintain-xero-accounting')) return 0
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
  if (settings.processingEnabled !== true) return { state: 'processing-paused' }
  const recovered = await recoverStaleExports(payload, req)
  const dispatched = await dispatchPreparingExports(payload, req)
  const webhookReceipts = await schedulePendingWebhookReceipts(payload, req)
  const statusRefreshes = await scheduleStatusRefresh(payload, req)
  const maintenanceJobs = await scheduleConnectionMaintenance(payload, req)
  return {
    dispatched: dispatched.dispatched,
    dispatchErrors: dispatched.errors,
    maintenanceJobs,
    recovered,
    state: 'ready',
    statusRefreshes,
    webhookReceipts,
  }
}
