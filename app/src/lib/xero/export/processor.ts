import 'server-only'

import { randomUUID } from 'node:crypto'

import { TIME_ENTRY_BILLING_MUTATION_CONTEXT } from '@/collections/TimeEntries'
import { recordAuditEvent } from '@/lib/audit/service'
import { stableHash } from '@/lib/billing/stable'
import { isRecord, relationshipID } from '@/lib/domain/validation'
import { requireMongoModel } from '@/lib/payload/mongo'
import { withPayloadTransaction } from '@/lib/payload/withTransaction'
import type { XeroAccountingClient } from '@/lib/xero/accounting/client'
import { AccountingIntegrationError } from '@/lib/xero/accounting/contracts'
import {
  createAccountingSystemSession,
  getValidAccountingAccessToken,
  resolveAccountingRuntime,
} from '@/lib/xero/accounting/service'
import type { InvoiceExport, InvoiceExportEntry, XeroAttempt } from '@/payload-types'

import type { Payload, PayloadRequest } from 'payload'

const PROCESSING_LEASE_MS = 2 * 60 * 1_000
const MAX_BLIND_REPOST_AGE_MS = 24 * 60 * 60 * 1_000
const BASE_RETRY_SECONDS = 30

export function classifyExportFailure(
  error: AccountingIntegrationError,
  attemptMayHaveBeenSent: boolean,
): 'action-required' | 'reconciling' | 'retry-wait' {
  // A received 4xx response proves that this specific request did not create an
  // invoice, even though the durable pre-send marker was conservatively set.
  if (!error.requestMayHaveBeenSent && error.status && error.status < 500) {
    if (error.retryable || error.status === 429 || error.status === 401) return 'retry-wait'
    return 'action-required'
  }
  if (error.requestMayHaveBeenSent || attemptMayHaveBeenSent) return 'reconciling'
  if (error.retryable || error.status === 429 || error.status === 401) return 'retry-wait'
  return 'action-required'
}

type ClaimedExport = InvoiceExport & { processingLeaseId: string }

export type RemoteInvoice = {
  contactID: string
  currency: string
  invoiceID: string
  invoiceNumber?: string
  lineItems: Record<string, unknown>[]
  lineItemIDs: (string | undefined)[]
  reference: string
  status: string
  subtotal?: number
  total?: number
}

type QueueTask = (args: {
  input: { exportID: string }
  meta?: Record<string, unknown>
  queue: string
  task: 'create-xero-invoice' | 'reconcile-xero-invoice'
  waitUntil?: Date
}) => Promise<{ id: number | string }>

const relation = (value: unknown): string | null => {
  const id = relationshipID(value)
  return id === null ? null : String(id)
}

const safeString = (value: unknown, max = 500): string | undefined =>
  typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined

const stateHistory = (
  exportDocument: InvoiceExport,
  to: InvoiceExport['state'],
  metadata?: Record<string, unknown>,
): unknown[] => [
  ...(Array.isArray(exportDocument.stateHistory) ? exportDocument.stateHistory : []),
  {
    at: new Date().toISOString(),
    from: exportDocument.state,
    machineActor: 'xero-export-worker',
    metadata,
    to,
  },
]

export const parseRemoteInvoices = (value: unknown): RemoteInvoice[] => {
  if (!isRecord(value) || !Array.isArray(value.Invoices)) {
    throw new AccountingIntegrationError(
      'invalid-invoice-response',
      'Xero returned an unexpected invoice response.',
      { requestMayHaveBeenSent: true },
    )
  }
  return value.Invoices.map((invoice) => {
    if (!isRecord(invoice) || !isRecord(invoice.Contact) || !Array.isArray(invoice.LineItems)) {
      throw new AccountingIntegrationError(
        'invalid-invoice-response',
        'Xero returned an unexpected invoice response.',
        { requestMayHaveBeenSent: true },
      )
    }
    const invoiceID = safeString(invoice.InvoiceID, 100)
    const contactID = safeString(invoice.Contact.ContactID, 100)
    const currency = safeString(invoice.CurrencyCode, 3)
    const reference = safeString(invoice.Reference, 255)
    const status = safeString(invoice.Status, 50)
    if (!invoiceID || !contactID || !currency || !reference || !status) {
      throw new AccountingIntegrationError(
        'invalid-invoice-response',
        'Xero returned an incomplete invoice response.',
        { requestMayHaveBeenSent: true },
      )
    }
    const lineItems = invoice.LineItems.map((item) => (isRecord(item) ? item : {}))
    return {
      contactID,
      currency,
      invoiceID,
      invoiceNumber: safeString(invoice.InvoiceNumber, 100),
      lineItemIDs: lineItems.map((item) => safeString(item.LineItemID, 100)),
      lineItems,
      reference,
      status,
      subtotal: typeof invoice.SubTotal === 'number' ? invoice.SubTotal : undefined,
      total: typeof invoice.Total === 'number' ? invoice.Total : undefined,
    }
  })
}

const parseRemoteInvoice = (value: unknown): RemoteInvoice => {
  const invoices = parseRemoteInvoices(value)
  if (invoices.length !== 1) {
    throw new AccountingIntegrationError(
      'invalid-invoice-response',
      'Xero returned an unexpected invoice count.',
      { requestMayHaveBeenSent: true },
    )
  }
  return invoices[0] as RemoteInvoice
}

const requestInvoice = (exportDocument: InvoiceExport): Record<string, unknown> => {
  if (!isRecord(exportDocument.requestPayload)) {
    throw new AccountingIntegrationError('invalid-snapshot', 'The saved Xero request is invalid.')
  }
  return exportDocument.requestPayload
}

export const materiallyMatches = (
  exportDocument: InvoiceExport,
  remote: RemoteInvoice,
  allocations: InvoiceExportEntry[],
): boolean => {
  const payload = requestInvoice(exportDocument)
  const requestLines = Array.isArray(payload.LineItems) ? payload.LineItems : []
  const lineValuesMatch = requestLines.every((line, index) => {
    const remoteLine = remote.lineItems[index]
    if (!isRecord(line) || !remoteLine) return false
    const numberMatches = (expected: unknown, actual: unknown): boolean =>
      typeof expected === 'number' && typeof actual === 'number'
        ? Math.abs(expected - actual) < 0.000_05
        : expected === actual
    return (
      line.Description === remoteLine.Description &&
      line.AccountCode === remoteLine.AccountCode &&
      line.TaxType === remoteLine.TaxType &&
      numberMatches(line.Quantity, remoteLine.Quantity) &&
      numberMatches(line.UnitAmount, remoteLine.UnitAmount) &&
      stableHash(
        Array.isArray(line.Tracking)
          ? line.Tracking.map((item) =>
              isRecord(item) ? { Name: item.Name, Option: item.Option } : {},
            )
          : [],
      ) ===
        stableHash(
          Array.isArray(remoteLine.Tracking)
            ? remoteLine.Tracking.map((item) =>
                isRecord(item) ? { Name: item.Name, Option: item.Option } : {},
              )
            : [],
        )
    )
  })
  const totalsMatch =
    (remote.subtotal === undefined ||
      Math.abs(remote.subtotal * 10_000 - exportDocument.subtotalScaled) < 1) &&
    (remote.total === undefined || Math.abs(remote.total * 10_000 - exportDocument.totalScaled) < 1)
  return (
    isRecord(payload.Contact) &&
    payload.Contact.ContactID === remote.contactID &&
    payload.CurrencyCode === remote.currency &&
    payload.Reference === remote.reference &&
    remote.reference === exportDocument.applicationReference &&
    remote.lineItemIDs.length === allocations.length &&
    lineValuesMatch &&
    totalsMatch
  )
}

const loadAllocations = async (
  payload: Payload,
  req: PayloadRequest,
  exportID: string,
): Promise<InvoiceExportEntry[]> => {
  const result = await payload.find({
    collection: 'invoice-export-entries',
    depth: 0,
    limit: 1_000,
    overrideAccess: true,
    pagination: false,
    req,
    sort: 'lineOrdinal',
    where: { invoiceExport: { equals: exportID } },
  })
  return result.docs
}

const loadAttempt = async (
  payload: Payload,
  req: PayloadRequest,
  exportDocument: InvoiceExport,
): Promise<XeroAttempt> => {
  const attemptID = relation(exportDocument.currentAttempt)
  if (!attemptID)
    throw new AccountingIntegrationError('missing-attempt', 'The Xero attempt is missing.')
  return payload.findByID({
    collection: 'xero-attempts',
    depth: 0,
    id: attemptID,
    overrideAccess: true,
    req,
    showHiddenFields: true,
  })
}

const claimExport = async (payload: Payload, exportID: string): Promise<ClaimedExport | null> => {
  const leaseID = randomUUID()
  const now = new Date()
  const claimed = await requireMongoModel(payload, 'invoice-exports').findOneAndUpdate(
    {
      _id: exportID,
      $and: [
        { state: { $in: ['queued', 'retry-wait'] } },
        {
          $or: [
            { nextAttemptAt: null },
            { nextAttemptAt: { $exists: false } },
            { nextAttemptAt: { $lte: now } },
          ],
        },
        {
          $or: [
            { processingLeaseExpiresAt: null },
            { processingLeaseExpiresAt: { $exists: false } },
            { processingLeaseExpiresAt: { $lte: now } },
          ],
        },
      ],
    },
    {
      $set: {
        lastAttemptAt: now,
        nextAttemptAt: null,
        processingAt: now,
        processingLeaseExpiresAt: new Date(Date.now() + PROCESSING_LEASE_MS),
        processingLeaseId: leaseID,
        state: 'processing',
        updatedAt: now,
      },
    },
    { new: true },
  )
  if (!claimed) return null
  const document = claimed.toObject() as Record<string, unknown>
  return {
    ...document,
    id: String(document._id),
    processingLeaseId: leaseID,
  } as ClaimedExport
}

const ensureReserved = async (
  payload: Payload,
  req: PayloadRequest,
  exportID: string,
  allocations: InvoiceExportEntry[],
): Promise<void> => {
  if (allocations.length === 0) {
    throw new AccountingIntegrationError(
      'missing-allocations',
      'The export has no saved invoice lines.',
    )
  }
  for (const allocation of allocations) {
    const entryID = relation(allocation.timeEntry)
    if (!entryID)
      throw new AccountingIntegrationError('missing-entry', 'An export entry is invalid.')
    const entry = await payload.findByID({
      collection: 'time-entries',
      depth: 0,
      id: entryID,
      overrideAccess: true,
      req,
    })
    if (entry.billingStatus !== 'reserved' || relation(entry.currentExport) !== exportID) {
      throw new AccountingIntegrationError(
        'reservation-mismatch',
        'A time entry is no longer reserved to this export.',
      )
    }
  }
}

const updateBatchStatus = async (
  payload: Payload,
  req: PayloadRequest,
  batchID: string | null,
): Promise<void> => {
  if (!batchID) return
  const children = await payload.find({
    collection: 'invoice-exports',
    depth: 0,
    limit: 100,
    overrideAccess: true,
    pagination: false,
    req,
    where: { batch: { equals: batchID } },
  })
  const states = children.docs.map((item) => item.state)
  const terminalSuccess = states.every((state) => state === 'succeeded' || state === 'released')
  const terminalCancelled = states.every((state) => state === 'cancelled')
  const hasProblem = states.some(
    (state) => state === 'action-required' || state === 'manual-review',
  )
  const hasSuccess = states.some((state) => state === 'succeeded' || state === 'released')
  const status = terminalSuccess
    ? 'succeeded'
    : terminalCancelled
      ? 'cancelled'
      : hasProblem && hasSuccess
        ? 'partial'
        : hasProblem
          ? 'action-required'
          : states.some((state) => state === 'processing')
            ? 'processing'
            : 'queued'
  await payload.update({
    collection: 'export-batches',
    id: batchID,
    data: {
      completedAt:
        terminalSuccess || terminalCancelled || hasProblem ? new Date().toISOString() : undefined,
      status,
    },
    overrideAccess: true,
    req,
  })
}

export async function finalizeInvoiceSuccess(input: {
  attempt: XeroAttempt
  correlationID?: string
  exportDocument: InvoiceExport
  leaseID?: string
  payload: Payload
  rateLimitRemaining?: number
  remote: RemoteInvoice
  req: PayloadRequest
}): Promise<'manual-review' | 'succeeded'> {
  const exportID = String(input.exportDocument.id)
  const allocations = await loadAllocations(input.payload, input.req, exportID)
  if (!materiallyMatches(input.exportDocument, input.remote, allocations)) {
    await input.payload.update({
      collection: 'xero-attempts',
      id: input.attempt.id,
      data: {
        completedAt: new Date().toISOString(),
        result: 'manual-review',
        safeResponseMetadata: { invoiceID: input.remote.invoiceID, status: input.remote.status },
        xeroCorrelationId: input.correlationID,
      },
      overrideAccess: true,
      req: input.req,
    })
    await input.payload.update({
      collection: 'invoice-exports',
      id: exportID,
      data: {
        lastErrorCode: 'material-response-mismatch',
        lastErrorMessage: 'Xero created an invoice whose material values require manual review.',
        processingLeaseExpiresAt: null,
        processingLeaseId: null,
        remoteStatus: input.remote.status,
        state: 'manual-review',
        stateHistory: stateHistory(input.exportDocument, 'manual-review'),
        xeroInvoiceId: input.remote.invoiceID,
        xeroInvoiceNumber: input.remote.invoiceNumber,
      },
      overrideAccess: true,
      req: input.req,
    })
    return 'manual-review'
  }

  await withPayloadTransaction(input.payload, async (req) => {
    const current = await input.payload.findByID({
      collection: 'invoice-exports',
      depth: 0,
      id: exportID,
      overrideAccess: true,
      req,
      showHiddenFields: true,
    })
    if (current.state === 'succeeded' || current.state === 'released') return
    if (input.leaseID && current.processingLeaseId !== input.leaseID) {
      throw new Error('The export processing lease is no longer owned by this worker.')
    }
    const currentAllocations = await loadAllocations(input.payload, req, exportID)
    await ensureReserved(input.payload, req, exportID, currentAllocations)
    const now = new Date().toISOString()
    for (const allocation of currentAllocations) {
      const entryID = relation(allocation.timeEntry)
      if (!entryID) throw new Error('An allocation has no time entry.')
      await input.payload.update({
        collection: 'invoice-export-entries',
        id: allocation.id,
        data: { xeroLineItemId: input.remote.lineItemIDs[allocation.lineOrdinal] },
        overrideAccess: true,
        req,
      })
      await input.payload.update({
        collection: 'time-entries',
        context: { [TIME_ENTRY_BILLING_MUTATION_CONTEXT]: 'export' },
        id: entryID,
        data: {
          billingStatus: 'exported',
          currentExport: exportID,
          exportedAt: now,
          reservedAt: (
            await input.payload.findByID({
              collection: 'time-entries',
              id: entryID,
              depth: 0,
              overrideAccess: true,
              req,
            })
          ).reservedAt,
        },
        overrideAccess: true,
        req,
      })
    }
    await input.payload.update({
      collection: 'xero-attempts',
      id: input.attempt.id,
      data: {
        completedAt: now,
        rateLimitRemaining: input.rateLimitRemaining,
        result: 'succeeded',
        safeResponseMetadata: {
          invoiceID: input.remote.invoiceID,
          invoiceNumber: input.remote.invoiceNumber,
          lineCount: currentAllocations.length,
          status: input.remote.status,
        },
        xeroCorrelationId: input.correlationID,
      },
      overrideAccess: true,
      req,
    })
    await input.payload.update({
      collection: 'invoice-exports',
      id: exportID,
      data: {
        dispatchState: 'complete',
        lastErrorCode: null,
        lastErrorMessage: null,
        lastRemoteUpdateAt: now,
        processingLeaseExpiresAt: null,
        processingLeaseId: null,
        remoteStatus: input.remote.status,
        state: 'succeeded',
        stateHistory: stateHistory(current, 'succeeded'),
        succeededAt: now,
        xeroInvoiceId: input.remote.invoiceID,
        xeroInvoiceNumber: input.remote.invoiceNumber,
        xeroInvoiceUrl: `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${encodeURIComponent(input.remote.invoiceID)}`,
      },
      overrideAccess: true,
      req,
    })
    await recordAuditEvent(
      input.payload,
      {
        correlationId: input.correlationID,
        eventType: 'export.state-changed',
        exportId: exportID,
        machineActor: 'xero-export-worker',
        metadata: { from: current.state, to: 'succeeded' },
        targetCollection: 'invoice-exports',
        targetId: exportID,
        xeroInvoiceId: input.remote.invoiceID,
      },
      req,
    )
  })
  await updateBatchStatus(input.payload, input.req, relation(input.exportDocument.batch))
  return 'succeeded'
}

const releaseAfterDefiniteFailure = async (
  payload: Payload,
  req: PayloadRequest,
  exportDocument: InvoiceExport,
  attempt: XeroAttempt,
  error: AccountingIntegrationError,
): Promise<void> => {
  const exportID = String(exportDocument.id)
  await withPayloadTransaction(payload, async (transactionReq) => {
    const allocations = await loadAllocations(payload, transactionReq, exportID)
    const now = new Date().toISOString()
    for (const allocation of allocations) {
      const entryID = relation(allocation.timeEntry)
      if (!entryID) continue
      const entry = await payload.findByID({
        collection: 'time-entries',
        id: entryID,
        depth: 0,
        overrideAccess: true,
        req: transactionReq,
      })
      if (entry.billingStatus === 'reserved' && relation(entry.currentExport) === exportID) {
        await payload.update({
          collection: 'time-entries',
          context: { [TIME_ENTRY_BILLING_MUTATION_CONTEXT]: 'release' },
          id: entryID,
          data: {
            billingStatus: 'unbilled',
            currentExport: null,
            exportedAt: null,
            reservedAt: null,
          },
          overrideAccess: true,
          req: transactionReq,
        })
      }
    }
    await payload.update({
      collection: 'xero-attempts',
      id: attempt.id,
      data: {
        completedAt: now,
        errorCode: error.code,
        errorMessage: error.message,
        httpStatus: error.status,
        rateLimitRemaining: error.rateLimitRemaining,
        result: 'definitely-not-created',
        retryAfterSeconds: error.retryAfterSeconds,
        xeroCorrelationId: error.correlationID,
      },
      overrideAccess: true,
      req: transactionReq,
    })
    await payload.update({
      collection: 'invoice-exports',
      id: exportID,
      data: {
        dispatchState: 'complete',
        lastErrorCode: error.code,
        lastErrorMessage: error.message,
        processingLeaseExpiresAt: null,
        processingLeaseId: null,
        state: 'action-required',
        stateHistory: stateHistory(exportDocument, 'action-required', {
          reservationsReleased: true,
        }),
      },
      overrideAccess: true,
      req: transactionReq,
    })
    await recordAuditEvent(
      payload,
      {
        correlationId: error.correlationID,
        eventType: 'export.state-changed',
        exportId: exportID,
        machineActor: 'xero-export-worker',
        metadata: { errorCode: error.code, reservationsReleased: true, to: 'action-required' },
        targetCollection: 'invoice-exports',
        targetId: exportID,
      },
      transactionReq,
    )
  })
  await updateBatchStatus(payload, req, relation(exportDocument.batch))
}

const queueFollowUp = async (
  payload: Payload,
  exportID: string,
  task: 'create-xero-invoice' | 'reconcile-xero-invoice',
  waitUntil: Date,
): Promise<string> => {
  const job = await (payload.jobs.queue as unknown as QueueTask)({
    input: { exportID },
    meta: { exportID, reason: task },
    queue: 'xero',
    task,
    waitUntil,
  })
  return String(job.id)
}

const retryDelaySeconds = (
  exportDocument: InvoiceExport,
  error: AccountingIntegrationError,
): number => {
  if (error.retryAfterSeconds && error.retryAfterSeconds >= 0)
    return Math.min(error.retryAfterSeconds, 3_600)
  const exponent = Math.min(Math.max(exportDocument.currentAttemptNumber ?? 1, 1), 6)
  return BASE_RETRY_SECONDS * 2 ** (exponent - 1) + Math.floor(Math.random() * 10)
}

const deferExport = async (
  payload: Payload,
  req: PayloadRequest,
  exportDocument: InvoiceExport,
  attempt: XeroAttempt,
  error: AccountingIntegrationError,
  state: 'reconciling' | 'retry-wait',
): Promise<void> => {
  const delay = state === 'reconciling' ? 30 : retryDelaySeconds(exportDocument, error)
  const nextAttemptAt = new Date(Date.now() + delay * 1_000)
  const jobID = await queueFollowUp(
    payload,
    String(exportDocument.id),
    state === 'reconciling' ? 'reconcile-xero-invoice' : 'create-xero-invoice',
    nextAttemptAt,
  )
  await payload.update({
    collection: 'xero-attempts',
    id: attempt.id,
    data: {
      errorCode: error.code,
      errorMessage: error.message,
      httpStatus: error.status,
      rateLimitRemaining: error.rateLimitRemaining,
      requestMayHaveBeenSent: attempt.requestMayHaveBeenSent || error.requestMayHaveBeenSent,
      result: state === 'reconciling' ? 'ambiguous' : 'retryable-before-send',
      retryAfterSeconds: delay,
      xeroCorrelationId: error.correlationID,
    },
    overrideAccess: true,
    req,
  })
  await payload.update({
    collection: 'invoice-exports',
    id: exportDocument.id,
    data: {
      jobId: jobID,
      lastErrorCode: error.code,
      lastErrorMessage: error.message,
      nextAttemptAt: nextAttemptAt.toISOString(),
      processingLeaseExpiresAt: null,
      processingLeaseId: null,
      state,
      stateHistory: stateHistory(exportDocument, state, { retryAt: nextAttemptAt.toISOString() }),
    },
    overrideAccess: true,
    req,
  })
  await recordAuditEvent(
    payload,
    {
      correlationId: error.correlationID,
      eventType: 'export.state-changed',
      exportId: exportDocument.id,
      machineActor: 'xero-export-worker',
      metadata: { errorCode: error.code, retryAt: nextAttemptAt.toISOString(), to: state },
      targetCollection: 'invoice-exports',
      targetId: exportDocument.id,
    },
    req,
  )
}

const markManualReview = async (
  payload: Payload,
  req: PayloadRequest,
  exportDocument: InvoiceExport,
  attempt: XeroAttempt,
  code: string,
  message: string,
): Promise<void> => {
  await payload.update({
    collection: 'xero-attempts',
    id: attempt.id,
    data: {
      completedAt: new Date().toISOString(),
      errorCode: code,
      errorMessage: message,
      result: 'manual-review',
    },
    overrideAccess: true,
    req,
  })
  await payload.update({
    collection: 'invoice-exports',
    id: exportDocument.id,
    data: {
      lastErrorCode: code,
      lastErrorMessage: message,
      processingLeaseExpiresAt: null,
      processingLeaseId: null,
      state: 'manual-review',
      stateHistory: stateHistory(exportDocument, 'manual-review'),
    },
    overrideAccess: true,
    req,
  })
}

export async function processInvoiceExport(
  jobReq: PayloadRequest,
  exportID: string,
  overrides: {
    client?: XeroAccountingClient
    token?: Awaited<ReturnType<typeof getValidAccountingAccessToken>>
  } = {},
): Promise<{ state: string }> {
  const payload = jobReq.payload
  const settings = await payload.findGlobal({
    slug: 'billing-settings',
    depth: 0,
    overrideAccess: true,
    req: jobReq,
  })
  if (settings.processingEnabled !== true) {
    await requireMongoModel(payload, 'invoice-exports').updateOne(
      { _id: exportID, state: { $in: ['queued', 'retry-wait'] } },
      {
        $set: { dispatchState: 'pending', jobId: null, state: 'preparing', updatedAt: new Date() },
      },
    )
    return { state: 'processing-paused' }
  }
  const claimed = await claimExport(payload, exportID)
  if (!claimed) {
    const current = await payload.findByID({
      collection: 'invoice-exports',
      id: exportID,
      depth: 0,
      overrideAccess: true,
      req: jobReq,
    })
    return { state: current.state }
  }
  const systemSession = await createAccountingSystemSession(payload)
  const req = systemSession.req
  const allocations = await loadAllocations(payload, req, exportID)
  const attempt = await loadAttempt(payload, req, claimed)
  let requestMayHaveBeenSent = attempt.requestMayHaveBeenSent

  try {
    const savedPayload = requestInvoice(claimed)
    if (
      stableHash(savedPayload) !== claimed.payloadHash ||
      attempt.payloadHash !== claimed.payloadHash
    ) {
      await markManualReview(
        payload,
        req,
        claimed,
        attempt,
        'payload-hash-mismatch',
        'The immutable Xero payload hash no longer matches.',
      )
      return { state: 'manual-review' }
    }
    await ensureReserved(payload, req, exportID, allocations)
    if (
      attempt.requestMayHaveBeenSent &&
      attempt.requestStartedAt &&
      Date.parse(attempt.requestStartedAt) < Date.now() - MAX_BLIND_REPOST_AGE_MS
    ) {
      await deferExport(
        payload,
        req,
        claimed,
        attempt,
        new AccountingIntegrationError(
          'idempotency-window-uncertain',
          'A targeted read is required before another POST.',
          { requestMayHaveBeenSent: true },
        ),
        'reconciling',
      )
      return { state: 'reconciling' }
    }

    const runtime = overrides.client ? null : await resolveAccountingRuntime(systemSession)
    const client = overrides.client ?? runtime?.client
    if (!client)
      throw new AccountingIntegrationError('not-configured', 'Xero accounting is not configured.')
    let token =
      overrides.token ??
      (await getValidAccountingAccessToken(
        systemSession,
        runtime ?? {
          client,
        },
      ))
    const tenantID = token.connection.tenantId
    if (!tenantID)
      throw new AccountingIntegrationError('missing-tenant', 'The Xero tenant is unavailable.')
    await payload.update({
      collection: 'xero-attempts',
      id: attempt.id,
      data: {
        claimId: claimed.processingLeaseId,
        leaseExpiresAt: new Date(Date.now() + PROCESSING_LEASE_MS).toISOString(),
        requestMayHaveBeenSent: true,
        requestStartedAt: new Date().toISOString(),
      },
      overrideAccess: true,
      req,
    })
    requestMayHaveBeenSent = true

    let response
    try {
      response = await client.accountingPost(
        token.accessToken,
        tenantID,
        'Invoices',
        { Invoices: [savedPayload] },
        attempt.idempotencyKey,
      )
    } catch (error) {
      if (error instanceof AccountingIntegrationError && error.status === 401) {
        await requireMongoModel(payload, 'xero-connections').updateOne(
          { _id: token.connection.id, status: 'connected' },
          { $set: { accessTokenExpiresAt: new Date(0) } },
        )
        token = overrides.token ?? (await getValidAccountingAccessToken(systemSession, { client }))
        response = await client.accountingPost(
          token.accessToken,
          tenantID,
          'Invoices',
          { Invoices: [savedPayload] },
          attempt.idempotencyKey,
        )
      } else {
        throw error
      }
    }
    const remote = parseRemoteInvoice(response.data)
    const state = await finalizeInvoiceSuccess({
      attempt,
      correlationID: response.correlationID,
      exportDocument: claimed,
      leaseID: claimed.processingLeaseId,
      payload,
      rateLimitRemaining: response.rateLimitRemaining,
      remote,
      req,
    })
    return { state }
  } catch (unknownError) {
    const error =
      unknownError instanceof AccountingIntegrationError
        ? unknownError
        : new AccountingIntegrationError(
            'export-worker-failed',
            'The export worker failed safely.',
            {
              cause: unknownError,
              requestMayHaveBeenSent,
              retryable: true,
            },
          )
    const failureState = classifyExportFailure(error, requestMayHaveBeenSent)
    if (failureState === 'action-required') {
      await releaseAfterDefiniteFailure(payload, req, claimed, attempt, error)
      return { state: 'action-required' }
    }
    if (failureState === 'reconciling') {
      await deferExport(payload, req, claimed, attempt, error, 'reconciling')
      return { state: 'reconciling' }
    }
    await deferExport(payload, req, claimed, attempt, error, 'retry-wait')
    return { state: 'retry-wait' }
  }
}
