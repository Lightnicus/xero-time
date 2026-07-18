import 'server-only'

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

import { createLocalReq, type Payload, type PayloadRequest } from 'payload'

import { recordAuditEvent } from '@/lib/audit/service'
import { isRecord } from '@/lib/domain/validation'
import { environment } from '@/lib/env'
import { requireMongoModel } from '@/lib/payload/mongo'

import { refreshInvoiceExportStatus } from './reconciliation'

const MAX_WEBHOOK_BYTES = 256 * 1_024
const MAX_EVENTS = 100
const LEASE_MS = 2 * 60 * 1_000

type WebhookEvent = {
  eventAt: string
  eventType: string
  resourceID: string
  resourceType: string
  tenantID: string
}

type QueueTask = (args: {
  input: { receiptID: string }
  meta?: Record<string, unknown>
  queue: string
  req?: PayloadRequest
  task: 'process-xero-webhook-receipt'
}) => Promise<{ id: number | string }>

const safeToken = (value: unknown, max = 100): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\r\n]/.test(value)
    ? value
    : null

export function validXeroWebhookSignature(
  rawBody: string,
  signature: string,
  key = environment.xeroWebhookKey,
): boolean {
  if (!key || signature.length > 500) return false
  const expected = createHmac('sha256', key).update(rawBody, 'utf8').digest()
  let received: Buffer
  try {
    received = Buffer.from(signature, 'base64')
  } catch {
    return false
  }
  return received.length === expected.length && timingSafeEqual(received, expected)
}

export const parseXeroWebhookEvents = (rawBody: string): WebhookEvent[] => {
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_WEBHOOK_BYTES) {
    throw new Error('The webhook request is too large.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    throw new Error('The webhook body is not valid JSON.')
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.events) || parsed.events.length > MAX_EVENTS) {
    throw new Error('The webhook event envelope is invalid.')
  }
  return parsed.events.map((event) => {
    if (!isRecord(event)) throw new Error('A webhook event is invalid.')
    const tenantID = safeToken(event.tenantId)
    const resourceID = safeToken(event.resourceId)
    const eventType = safeToken(event.eventType)
    const resourceType = safeToken(event.eventCategory ?? event.resourceType)
    const eventAt = safeToken(event.eventDateUtc, 100)
    if (
      !tenantID ||
      !resourceID ||
      !eventType ||
      !resourceType ||
      !eventAt ||
      !Number.isFinite(Date.parse(eventAt))
    ) {
      throw new Error('A webhook event is incomplete.')
    }
    return { eventAt, eventType, resourceID, resourceType, tenantID }
  })
}

const deduplicationKey = (event: WebhookEvent): string =>
  createHash('sha256')
    .update(
      `${event.tenantID}\u0000${event.resourceType}\u0000${event.resourceID}\u0000${event.eventType}\u0000${event.eventAt}`,
      'utf8',
    )
    .digest('base64url')

export async function persistXeroWebhook(
  payload: Payload,
  rawBody: string,
): Promise<{ duplicateCount: number; receiptCount: number }> {
  const events = parseXeroWebhookEvents(rawBody)
  const req = await createLocalReq({}, payload)
  let receiptCount = 0
  let duplicateCount = 0
  for (const event of events) {
    const key = deduplicationKey(event)
    const existing = await payload.find({
      collection: 'xero-webhook-receipts',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { deduplicationKey: { equals: key } },
    })
    if (existing.docs[0]) {
      duplicateCount += 1
      continue
    }
    try {
      const receipt = await payload.create({
        collection: 'xero-webhook-receipts',
        data: {
          deduplicationKey: key,
          eventAt: event.eventAt,
          eventType: event.eventType,
          receivedAt: new Date().toISOString(),
          resourceId: event.resourceID,
          resourceType: event.resourceType,
          retryCount: 0,
          status: 'pending',
          tenantId: event.tenantID,
        },
        overrideAccess: true,
        req,
      })
      const job = await (payload.jobs.queue as unknown as QueueTask)({
        input: { receiptID: String(receipt.id) },
        meta: { receiptID: String(receipt.id) },
        queue: 'xero',
        req,
        task: 'process-xero-webhook-receipt',
      })
      await payload.update({
        collection: 'xero-webhook-receipts',
        id: receipt.id,
        data: { jobId: String(job.id) },
        overrideAccess: true,
        req,
      })
      receiptCount += 1
    } catch (error) {
      const raced = await payload.find({
        collection: 'xero-webhook-receipts',
        depth: 0,
        limit: 1,
        overrideAccess: true,
        req,
        where: { deduplicationKey: { equals: key } },
      })
      if (raced.docs[0]) duplicateCount += 1
      else throw error
    }
  }
  return { duplicateCount, receiptCount }
}

export async function processWebhookReceipt(
  jobReq: PayloadRequest,
  receiptID: string,
  overrides: {
    refresh?: typeof refreshInvoiceExportStatus
  } = {},
): Promise<{ state: string }> {
  const payload = jobReq.payload
  const leaseID = randomUUID()
  const claimed = await requireMongoModel(payload, 'xero-webhook-receipts').findOneAndUpdate(
    {
      _id: receiptID,
      status: { $in: ['pending', 'failed'] },
      $or: [
        { processingLeaseExpiresAt: null },
        { processingLeaseExpiresAt: { $exists: false } },
        { processingLeaseExpiresAt: { $lte: new Date() } },
      ],
    },
    {
      $set: {
        processingLeaseExpiresAt: new Date(Date.now() + LEASE_MS),
        processingLeaseId: leaseID,
        status: 'processing',
        updatedAt: new Date(),
      },
    },
    { new: true },
  )
  if (!claimed) return { state: 'already-processed' }
  const receipt = claimed.toObject() as Record<string, unknown>
  const req = await createLocalReq({}, payload)
  try {
    const connection = await payload.find({
      collection: 'xero-connections',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { singletonKey: { equals: 'business-accounting' } },
    })
    if (!connection.docs[0]?.tenantId || connection.docs[0].tenantId !== receipt.tenantId) {
      await payload.update({
        collection: 'xero-webhook-receipts',
        id: receiptID,
        data: {
          failureCode: 'wrong-tenant',
          failureMessage: 'The event tenant does not match the pinned business tenant.',
          processedAt: new Date().toISOString(),
          processingLeaseExpiresAt: null,
          processingLeaseId: null,
          status: 'ignored',
        },
        overrideAccess: true,
        req,
      })
      await recordAuditEvent(
        payload,
        {
          eventType: 'xero.webhook-ignored',
          machineActor: 'xero-webhook-worker',
          metadata: { reason: 'wrong-tenant' },
          targetCollection: 'xero-webhook-receipts',
          targetId: receiptID,
        },
        req,
      )
      return { state: 'ignored' }
    }
    if (String(receipt.resourceType).toUpperCase() !== 'INVOICE') {
      await payload.update({
        collection: 'xero-webhook-receipts',
        id: receiptID,
        data: {
          processedAt: new Date().toISOString(),
          processingLeaseExpiresAt: null,
          processingLeaseId: null,
          status: 'ignored',
        },
        overrideAccess: true,
        req,
      })
      return { state: 'ignored' }
    }
    const exports = await payload.find({
      collection: 'invoice-exports',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { xeroInvoiceId: { equals: String(receipt.resourceId) } },
    })
    if (!exports.docs[0]) {
      await payload.update({
        collection: 'xero-webhook-receipts',
        id: receiptID,
        data: {
          processedAt: new Date().toISOString(),
          processingLeaseExpiresAt: null,
          processingLeaseId: null,
          status: 'ignored',
        },
        overrideAccess: true,
        req,
      })
      return { state: 'ignored' }
    }
    await (overrides.refresh ?? refreshInvoiceExportStatus)(jobReq, String(exports.docs[0].id))
    await payload.update({
      collection: 'xero-webhook-receipts',
      id: receiptID,
      data: {
        processedAt: new Date().toISOString(),
        processingLeaseExpiresAt: null,
        processingLeaseId: null,
        status: 'processed',
      },
      overrideAccess: true,
      req,
    })
    await recordAuditEvent(
      payload,
      {
        eventType: 'xero.webhook-processed',
        exportId: exports.docs[0].id,
        machineActor: 'xero-webhook-worker',
        targetCollection: 'xero-webhook-receipts',
        targetId: receiptID,
        xeroInvoiceId: String(receipt.resourceId),
      },
      req,
    )
    return { state: 'processed' }
  } catch (error) {
    await payload.update({
      collection: 'xero-webhook-receipts',
      id: receiptID,
      data: {
        failureCode: 'processing-failed',
        failureMessage: 'Webhook processing will be retried.',
        processingLeaseExpiresAt: null,
        processingLeaseId: null,
        retryCount: Number(receipt.retryCount ?? 0) + 1,
        status: 'failed',
      },
      overrideAccess: true,
      req,
    })
    throw error
  }
}
