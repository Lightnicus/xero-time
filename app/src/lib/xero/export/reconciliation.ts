import 'server-only'

import { randomUUID } from 'node:crypto'

import { recordAuditEvent } from '@/lib/audit/service'
import { isRecord, relationshipID } from '@/lib/domain/validation'
import type { AppSession } from '@/lib/member-app/session'
import { requireMongoModel } from '@/lib/payload/mongo'
import type { XeroAccountingClient } from '@/lib/xero/accounting/client'
import { AccountingIntegrationError } from '@/lib/xero/accounting/contracts'
import {
  XERO_RECONNECT_EXPORT_CODE,
  XERO_RECONNECT_EXPORT_MESSAGE,
  XERO_RECONNECT_RECHECK_SECONDS,
} from '@/lib/xero/accounting/recovery'
import {
  createAccountingSystemSession,
  getValidAccountingAccessToken,
  resolveAccountingRuntime,
} from '@/lib/xero/accounting/service'
import type { InvoiceExport, InvoiceExportEntry, XeroAttempt } from '@/payload-types'

import {
  consecutiveRetries,
  finalizeInvoiceSuccess,
  MAX_CONSECUTIVE_RETRIES,
  materiallyMatches,
  parseRemoteInvoices,
  remoteDerivedValuesHash,
  remoteDerivedValuesMatchAttempt,
  RETRY_LIMIT_ERROR_CODE,
  retryLimitMessage,
} from './processor'

import type { Payload, PayloadRequest } from 'payload'

const LEASE_MS = 2 * 60 * 1_000
const SAME_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1_000

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

const expectedInvoiceIdentity = (
  document: InvoiceExport,
): { contactID: string; currency: string } => {
  const request = document.requestPayload
  const contact = isRecord(request) && isRecord(request.Contact) ? request.Contact : null
  const contactID = contact?.ContactID
  const currency = isRecord(request) ? request.CurrencyCode : null
  if (
    typeof contactID !== 'string' ||
    !contactID.trim() ||
    typeof currency !== 'string' ||
    currency !== document.currency
  ) {
    throw new AccountingIntegrationError(
      'invalid-snapshot',
      'The saved Xero request does not contain a valid contact and currency identity.',
    )
  }
  return { contactID: contactID.trim(), currency }
}

const queue = async (
  payload: Payload,
  exportID: string,
  task: 'create-xero-invoice' | 'reconcile-xero-invoice',
  seconds: number,
): Promise<{ id: string; waitUntil: string }> => {
  const waitUntil = new Date(Date.now() + seconds * 1_000)
  const job = await (payload.jobs.queue as unknown as QueueTask)({
    input: { exportID },
    meta: { exportID, reason: 'reconciliation' },
    queue: 'xero',
    task,
    waitUntil,
  })
  return { id: String(job.id), waitUntil: waitUntil.toISOString() }
}

const loadAllocations = async (
  payload: Payload,
  req: PayloadRequest,
  exportID: string,
): Promise<InvoiceExportEntry[]> =>
  (
    await payload.find({
      collection: 'invoice-export-entries',
      depth: 0,
      limit: 1_000,
      overrideAccess: true,
      pagination: false,
      req,
      sort: 'lineOrdinal',
      where: { invoiceExport: { equals: exportID } },
    })
  ).docs

const claim = async (payload: Payload, exportID: string): Promise<InvoiceExport | null> => {
  const leaseID = randomUUID()
  const result = await requireMongoModel(payload, 'invoice-exports').findOneAndUpdate(
    {
      _id: exportID,
      state: 'reconciling',
      $or: [
        { processingLeaseExpiresAt: null },
        { processingLeaseExpiresAt: { $exists: false } },
        { processingLeaseExpiresAt: { $lte: new Date() } },
      ],
    },
    {
      $set: {
        lastReconciledAt: new Date(),
        processingLeaseExpiresAt: new Date(Date.now() + LEASE_MS),
        processingLeaseId: leaseID,
        updatedAt: new Date(),
      },
    },
    { new: true },
  )
  if (!result) return null
  const document = result.toObject() as Record<string, unknown>
  return {
    ...document,
    id: String(document._id),
    processingLeaseId: leaseID,
  } as InvoiceExport
}

const history = (
  document: InvoiceExport,
  to: InvoiceExport['state'],
  metadata?: unknown,
): unknown[] => [
  ...(Array.isArray(document.stateHistory) ? document.stateHistory : []),
  {
    at: new Date().toISOString(),
    from: document.state,
    machineActor: 'xero-reconciliation-worker',
    metadata,
    to,
  },
]

const markManualReview = async (
  payload: Payload,
  req: PayloadRequest,
  document: InvoiceExport,
  code: string,
  message: string,
  remoteID?: string,
): Promise<void> => {
  await payload.update({
    collection: 'invoice-exports',
    id: document.id,
    data: {
      lastErrorCode: code,
      lastErrorMessage: message,
      processingLeaseExpiresAt: null,
      processingLeaseId: null,
      state: 'manual-review',
      stateHistory: history(document, 'manual-review', { code }),
      xeroInvoiceId: remoteID ?? document.xeroInvoiceId,
    },
    overrideAccess: true,
    req,
  })
  await recordAuditEvent(
    payload,
    {
      eventType: 'export.reconciled',
      exportId: document.id,
      machineActor: 'xero-reconciliation-worker',
      metadata: { code, result: 'manual-review' },
      targetCollection: 'invoice-exports',
      targetId: document.id,
      xeroInvoiceId: remoteID,
    },
    req,
  )
}

export async function fetchRemoteInvoiceForExport(
  session: AppSession,
  document: InvoiceExport,
  clientOverride?: XeroAccountingClient,
  tokenOverride?: Awaited<ReturnType<typeof getValidAccountingAccessToken>>,
) {
  if (!document.xeroInvoiceId) {
    throw new AccountingIntegrationError(
      'missing-remote-invoice-id',
      'This export does not have a verified Xero InvoiceID.',
    )
  }
  const runtime = clientOverride ? null : await resolveAccountingRuntime(session)
  const client = clientOverride ?? runtime?.client
  if (!client)
    throw new AccountingIntegrationError('not-configured', 'Xero accounting is not configured.')
  const token =
    tokenOverride ??
    (await getValidAccountingAccessToken(
      session,
      runtime ?? {
        client,
      },
    ))
  if (!token.connection.tenantId) {
    throw new AccountingIntegrationError('missing-tenant', 'The Xero tenant is unavailable.')
  }
  const response = await client.accountingGet(
    token.accessToken,
    token.connection.tenantId,
    `Invoices/${document.xeroInvoiceId}`,
    { unitdp: '4' },
  )
  const invoices = parseRemoteInvoices(response.data)
  const remote = invoices.find((invoice) => invoice.invoiceID === document.xeroInvoiceId)
  if (!remote || invoices.length !== 1) {
    throw new AccountingIntegrationError(
      'invoice-not-found',
      'Xero did not return the expected invoice.',
      { retryable: true },
    )
  }
  return { remote, response }
}

/** Error codes the status refresh sets itself, and may therefore clear again. */
const STATUS_REFRESH_ERROR_CODES = new Set([
  'remote-invoice-mismatch',
  'remote-invoice-requires-action',
])

export async function refreshInvoiceExportStatus(
  jobReq: PayloadRequest,
  exportID: string,
  overrides: {
    client?: XeroAccountingClient
    token?: Awaited<ReturnType<typeof getValidAccountingAccessToken>>
  } = {},
): Promise<{ remoteStatus: string; state: string }> {
  const payload = jobReq.payload
  const session = await createAccountingSystemSession(payload)
  const document = await payload.findByID({
    collection: 'invoice-exports',
    depth: 0,
    id: exportID,
    overrideAccess: true,
    req: session.req,
    showHiddenFields: true,
  })
  const { remote, response } = await fetchRemoteInvoiceForExport(
    session,
    document,
    overrides.client,
    overrides.token,
  )
  const allocations = await loadAllocations(payload, session.req, exportID)
  const attemptID = relation(document.currentAttempt)
  const attempt = attemptID
    ? await payload.findByID({
        collection: 'xero-attempts',
        depth: 0,
        id: attemptID,
        overrideAccess: true,
        req: session.req,
        showHiddenFields: true,
      })
    : null
  const inputValuesMatch = materiallyMatches(document, remote, allocations)
  const derivedValuesMatch = remoteDerivedValuesMatchAttempt(attempt, remote)
  const matches = inputValuesMatch && derivedValuesMatch
  const currentDerivedValuesHash = remoteDerivedValuesHash(remote)
  const attemptMetadata =
    attempt && isRecord(attempt.safeResponseMetadata) ? attempt.safeResponseMetadata : {}
  const derivedValuesBaselineCreated = Boolean(
    matches &&
    attempt?.result === 'succeeded' &&
    currentDerivedValuesHash &&
    typeof attemptMetadata.remoteDerivedValuesHash !== 'string',
  )
  if (derivedValuesBaselineCreated && attempt && currentDerivedValuesHash) {
    await payload.update({
      collection: 'xero-attempts',
      data: {
        safeResponseMetadata: {
          ...attemptMetadata,
          remoteDerivedValuesHash: currentDerivedValuesHash,
        },
      },
      id: attempt.id,
      overrideAccess: true,
      req: session.req,
    })
  }
  const actionRequired = !matches || remote.status === 'DELETED' || remote.status === 'VOIDED'
  // A refresh decides the state of a finished export, or one it flagged itself. An export waiting
  // for review (or flagged for another reason) only moves when Xero reports its invoice deleted or
  // voided, which is what makes its time eligible for release. Exports a worker is handling keep
  // their state; the refresh then only records what Xero reports.
  const remoteClosed = remote.status === 'DELETED' || remote.status === 'VOIDED'
  const refreshOwnsState =
    document.state === 'succeeded' ||
    (document.state === 'action-required' &&
      STATUS_REFRESH_ERROR_CODES.has(document.lastErrorCode ?? '')) ||
    ((document.state === 'manual-review' || document.state === 'action-required') && remoteClosed)
  const nextState = refreshOwnsState
    ? actionRequired
      ? 'action-required'
      : 'succeeded'
    : document.state
  const now = new Date().toISOString()
  const stateFields = refreshOwnsState
    ? {
        lastErrorCode: actionRequired
          ? matches
            ? 'remote-invoice-requires-action'
            : 'remote-invoice-mismatch'
          : null,
        lastErrorMessage: actionRequired
          ? matches
            ? `The Xero invoice is ${remote.status}; review release eligibility.`
            : 'The Xero invoice no longer matches its immutable local snapshot.'
          : null,
        state: nextState,
        stateHistory:
          nextState === document.state
            ? document.stateHistory
            : history(document, nextState, { remoteStatus: remote.status }),
      }
    : {}
  // Write only if nothing else changed the export since it was read, so a concurrent release,
  // reconciliation, or recovery action is never overwritten by this slower Xero round trip.
  const written = await payload.update({
    collection: 'invoice-exports',
    data: {
      ...stateFields,
      lastReconciledAt: now,
      lastRemoteUpdateAt: now,
      remoteStatus: remote.status,
      xeroInvoiceNumber: remote.invoiceNumber ?? document.xeroInvoiceNumber,
    },
    depth: 0,
    overrideAccess: true,
    req: session.req,
    where: {
      and: [
        { id: { equals: exportID } },
        { state: { equals: document.state } },
        { updatedAt: { equals: document.updatedAt } },
      ],
    },
  })
  if (written.docs.length === 0) {
    return { remoteStatus: remote.status, state: 'superseded' }
  }
  await recordAuditEvent(
    payload,
    {
      correlationId: response.correlationID,
      eventType: 'export.reconciled',
      exportId: exportID,
      machineActor: 'xero-status-refresh',
      metadata: {
        derivedValuesBaselineCreated,
        derivedValuesMatch,
        inputValuesMatch,
        matches,
        remoteStatus: remote.status,
        state: nextState,
      },
      targetCollection: 'invoice-exports',
      targetId: exportID,
      xeroInvoiceId: remote.invoiceID,
    },
    session.req,
  )
  return { remoteStatus: remote.status, state: nextState }
}

const retryReconciliation = async (
  payload: Payload,
  req: PayloadRequest,
  document: InvoiceExport,
  code: string,
  message: string,
  delaySeconds = 60,
): Promise<void> => {
  const next = await queue(payload, String(document.id), 'reconcile-xero-invoice', delaySeconds)
  await payload.update({
    collection: 'invoice-exports',
    id: document.id,
    data: {
      jobId: next.id,
      lastErrorCode: code,
      lastErrorMessage: message,
      nextAttemptAt: next.waitUntil,
      processingLeaseExpiresAt: null,
      processingLeaseId: null,
      state: 'reconciling',
      stateHistory: history(document, 'reconciling', { errorCode: code, retryAt: next.waitUntil }),
    },
    overrideAccess: true,
    req,
  })
}

export async function reconcileInvoiceExport(
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
  if (settings.processingEnabled !== true) return { state: 'processing-paused' }
  const document = await claim(payload, exportID)
  if (!document) {
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
  const attemptID = relation(document.currentAttempt)
  if (!attemptID) {
    await markManualReview(
      payload,
      req,
      document,
      'missing-attempt',
      'The original Xero attempt is missing.',
    )
    return { state: 'manual-review' }
  }
  const attempt: XeroAttempt = await payload.findByID({
    collection: 'xero-attempts',
    depth: 0,
    id: attemptID,
    overrideAccess: true,
    req,
    showHiddenFields: true,
  })
  const allocations = await loadAllocations(payload, req, exportID)

  try {
    const runtime = overrides.client ? null : await resolveAccountingRuntime(systemSession)
    const client = overrides.client ?? runtime?.client
    if (!client)
      throw new AccountingIntegrationError('not-configured', 'Xero accounting is not configured.')
    const token =
      overrides.token ??
      (await getValidAccountingAccessToken(
        systemSession,
        runtime ?? {
          client,
        },
      ))
    if (!token.connection.tenantId)
      throw new AccountingIntegrationError('missing-tenant', 'The Xero tenant is unavailable.')
    const response = document.xeroInvoiceId
      ? await client.accountingGet(
          token.accessToken,
          token.connection.tenantId,
          `Invoices/${document.xeroInvoiceId}`,
          { unitdp: '4' },
        )
      : await client.accountingGet(token.accessToken, token.connection.tenantId, 'Invoices', {
          // Xero only includes line items in an invoice list when the request is paged, and
          // the snapshot comparison needs them.
          page: '1',
          unitdp: '4',
          where: `Reference=="${document.applicationReference.replaceAll('"', '\\"')}"`,
        })
    const remoteInvoices = parseRemoteInvoices(response.data)
    let invoices
    if (document.xeroInvoiceId) {
      invoices = remoteInvoices.filter((invoice) => invoice.invoiceID === document.xeroInvoiceId)
    } else {
      const expectedIdentity = expectedInvoiceIdentity(document)
      invoices = remoteInvoices.filter(
        (invoice) =>
          invoice.reference === document.applicationReference &&
          invoice.contactID === expectedIdentity.contactID &&
          invoice.currency === expectedIdentity.currency,
      )
    }
    if (invoices.length > 1) {
      await markManualReview(
        payload,
        req,
        document,
        'multiple-invoice-matches',
        'Several Xero invoices match this export reference, contact, and currency.',
      )
      return { state: 'manual-review' }
    }
    const remote = invoices[0]
    if (remote) {
      if (
        !materiallyMatches(document, remote, allocations) ||
        !remoteDerivedValuesMatchAttempt(attempt, remote)
      ) {
        await markManualReview(
          payload,
          req,
          document,
          'reconciliation-mismatch',
          'The matching Xero invoice differs from the immutable snapshot.',
          remote.invoiceID,
        )
        return { state: 'manual-review' }
      }
      const state = await finalizeInvoiceSuccess({
        attempt,
        correlationID: response.correlationID,
        exportDocument: document,
        leaseID: document.processingLeaseId ?? undefined,
        payload,
        rateLimitRemaining: response.rateLimitRemaining,
        remote,
        req,
      })
      return { state }
    }

    const startedAt = attempt.requestStartedAt ? Date.parse(attempt.requestStartedAt) : Number.NaN
    if (Number.isFinite(startedAt) && startedAt >= Date.now() - SAME_ATTEMPT_WINDOW_MS) {
      const next = await queue(payload, exportID, 'create-xero-invoice', 30)
      await payload.update({
        collection: 'xero-attempts',
        id: attempt.id,
        data: { result: 'pending' },
        overrideAccess: true,
        req,
      })
      await payload.update({
        collection: 'invoice-exports',
        id: document.id,
        data: {
          jobId: next.id,
          lastErrorCode: 'confirmed-absent-safe-retry',
          lastErrorMessage:
            'No matching invoice was found; retrying the identical request and idempotency key.',
          nextAttemptAt: next.waitUntil,
          processingLeaseExpiresAt: null,
          processingLeaseId: null,
          state: 'retry-wait',
          stateHistory: history(document, 'retry-wait', {
            confirmedAbsent: true,
            retryAt: next.waitUntil,
          }),
        },
        overrideAccess: true,
        req,
      })
      return { state: 'retry-wait' }
    }
    await markManualReview(
      payload,
      req,
      document,
      'confirmed-absent-replacement-approval-required',
      'No invoice was found after the original idempotency window. Approve a linked replacement attempt from the export page.',
    )
    return { state: 'manual-review' }
  } catch (unknownError) {
    const error =
      unknownError instanceof AccountingIntegrationError
        ? unknownError
        : new AccountingIntegrationError(
            'reconciliation-failed',
            'Xero reconciliation is temporarily unavailable.',
            { cause: unknownError, retryable: true },
          )
    if (error.reconnectRequired) {
      await retryReconciliation(
        payload,
        req,
        document,
        XERO_RECONNECT_EXPORT_CODE,
        XERO_RECONNECT_EXPORT_MESSAGE,
        XERO_RECONNECT_RECHECK_SECONDS,
      )
      return { state: 'reconciling' }
    }
    if (error.retryable || error.status === 429 || (error.status && error.status >= 500)) {
      if (consecutiveRetries(document, 'reconciling') >= MAX_CONSECUTIVE_RETRIES) {
        await markManualReview(
          payload,
          req,
          document,
          RETRY_LIMIT_ERROR_CODE,
          retryLimitMessage(error.message).slice(0, 500),
        )
        return { state: 'manual-review' }
      }
      await retryReconciliation(payload, req, document, error.code, error.message)
      return { state: 'reconciling' }
    }
    await markManualReview(payload, req, document, error.code, error.message)
    return { state: 'manual-review' }
  }
}
