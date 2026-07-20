import 'server-only'

import { randomUUID } from 'node:crypto'

import { hasActiveRole } from '@/access/roles'
import { TIME_ENTRY_BILLING_MUTATION_CONTEXT } from '@/collections/TimeEntries'
import { recordAuditEvent } from '@/lib/audit/service'
import { stableHash } from '@/lib/billing/stable'
import { relationshipID } from '@/lib/domain/validation'
import type { AppSession } from '@/lib/member-app/session'
import { requireMongoModel } from '@/lib/payload/mongo'
import { withPayloadTransaction } from '@/lib/payload/withTransaction'
import type { XeroAccountingClient } from '@/lib/xero/accounting/client'
import { AccountingIntegrationError } from '@/lib/xero/accounting/contracts'
import {
  getValidAccountingAccessToken,
  resolveAccountingRuntime,
} from '@/lib/xero/accounting/service'
import {
  finalizeInvoiceSuccess,
  materiallyMatches,
  parseRemoteInvoices,
} from '@/lib/xero/export/processor'
import {
  fetchRemoteInvoiceForExport,
  refreshInvoiceExportStatus,
} from '@/lib/xero/export/reconciliation'
import type { InvoiceExport, XeroAttempt } from '@/payload-types'

const relation = (value: unknown): string | null => {
  const id = relationshipID(value)
  return id === null ? null : String(id)
}

const reason = (value: string): string => {
  const result = value.trim()
  if (result.length < 10 || result.length > 1_000) {
    throw new Error('Enter a reason between 10 and 1,000 characters.')
  }
  return result
}

const history = (
  document: InvoiceExport,
  to: InvoiceExport['state'],
  actor: string,
  metadata?: unknown,
): unknown[] => [
  ...(Array.isArray(document.stateHistory) ? document.stateHistory : []),
  { actor, at: new Date().toISOString(), from: document.state, metadata, to },
]

const assertOwnerAdmin = (session: AppSession): void => {
  if (!hasActiveRole(session.user, ['owner', 'admin'])) {
    throw new Error('Only an owner or administrator can perform this action.')
  }
}

const loadExportAllocations = async (session: AppSession, exportID: string) =>
  (
    await session.payload.find({
      collection: 'invoice-export-entries',
      depth: 0,
      limit: 1_000,
      overrideAccess: true,
      pagination: false,
      req: session.req,
      sort: 'lineOrdinal',
      where: { invoiceExport: { equals: exportID } },
    })
  ).docs

const assertLocallyReleasable = async (
  session: AppSession,
  document: InvoiceExport,
  allocations: Awaited<ReturnType<typeof loadExportAllocations>>,
): Promise<void> => {
  if (document.state === 'released' || document.releaseAction) {
    throw new Error('This export was already released.')
  }
  if (allocations.length !== document.entryCount) {
    throw new Error('The saved export allocation count is inconsistent; release remains blocked.')
  }
  for (const allocation of allocations) {
    const entryID = relation(allocation.timeEntry)
    if (!entryID) throw new Error('An export allocation is invalid.')
    const entry = await session.payload.findByID({
      collection: 'time-entries',
      depth: 0,
      id: entryID,
      overrideAccess: true,
      req: session.req,
    })
    if (entry.billingStatus !== 'exported' || relation(entry.currentExport) !== document.id) {
      throw new Error('Every entry must still be exported by this exact invoice before release.')
    }
  }
}

const assertDeleteDraftCapability = async (
  session: AppSession,
  tenantID: string,
): Promise<void> => {
  const references = await session.payload.find({
    collection: 'xero-reference-data',
    depth: 0,
    limit: 2,
    overrideAccess: true,
    pagination: false,
    req: session.req,
    where: {
      and: [
        { sourceTenantId: { equals: tenantID } },
        { resourceType: { equals: 'organisation-action' } },
        { code: { equals: 'DeleteDraftInvoice' } },
        { status: { equals: 'active' } },
      ],
    },
  })
  if (references.docs.length !== 1) {
    throw new Error(
      'Deletion is blocked because cached Xero data has not confirmed draft-invoice deletion capability. Refresh Xero data and try again.',
    )
  }
}

export async function releaseInvoiceExport(
  session: AppSession,
  input: { confirmation: string; exportID: string; reason: string },
  overrides: {
    client?: XeroAccountingClient
    fetchRemote?: typeof fetchRemoteInvoiceForExport
  } = {},
): Promise<{ entryIDs: string[]; releaseID: string }> {
  assertOwnerAdmin(session)
  const releaseReason = reason(input.reason)
  const document = await session.payload.findByID({
    collection: 'invoice-exports',
    depth: 0,
    id: input.exportID,
    overrideAccess: true,
    req: session.req,
  })
  if (input.confirmation.trim() !== document.applicationReference) {
    throw new Error('Type the exact application reference to confirm release.')
  }
  if (document.state === 'released') throw new Error('This export was already released.')
  const { remote } = await (overrides.fetchRemote ?? fetchRemoteInvoiceForExport)(
    session,
    document,
    overrides.client,
  )
  if (remote.status !== 'DELETED' && remote.status !== 'VOIDED') {
    throw new Error(
      `Release is blocked because Xero currently reports ${remote.status}. Only DELETED or VOIDED invoices can be released.`,
    )
  }
  const verifiedRemoteStatus: 'DELETED' | 'VOIDED' = remote.status

  return withPayloadTransaction(
    session.payload,
    async (req) => {
      const current = await session.payload.findByID({
        collection: 'invoice-exports',
        depth: 0,
        id: input.exportID,
        overrideAccess: true,
        req,
      })
      if (current.state === 'released' || current.releaseAction) {
        throw new Error('This export was already released.')
      }
      if (current.xeroInvoiceId !== remote.invoiceID) {
        throw new Error('The verified remote invoice no longer matches this export.')
      }
      const allocations = await session.payload.find({
        collection: 'invoice-export-entries',
        depth: 0,
        limit: 1_000,
        overrideAccess: true,
        pagination: false,
        req,
        sort: 'lineOrdinal',
        where: { invoiceExport: { equals: input.exportID } },
      })
      if (allocations.docs.length !== current.entryCount) {
        throw new Error(
          'The saved export allocation count is inconsistent; release remains blocked.',
        )
      }
      const entryIDs = allocations.docs.map((allocation) => relation(allocation.timeEntry))
      if (entryIDs.some((entryID) => !entryID)) throw new Error('An export allocation is invalid.')
      for (const entryID of entryIDs as string[]) {
        const entry = await session.payload.findByID({
          collection: 'time-entries',
          depth: 0,
          id: entryID,
          overrideAccess: true,
          req,
        })
        if (
          entry.billingStatus !== 'exported' ||
          relation(entry.currentExport) !== input.exportID
        ) {
          throw new Error(
            'Every entry must still be exported by this exact invoice before release.',
          )
        }
      }
      const now = new Date().toISOString()
      const release = await session.payload.create({
        collection: 'release-actions',
        data: {
          actor: session.user.id,
          after: { billingStatus: 'unbilled', currentExport: null },
          amountScaled: current.totalScaled,
          before: { billingStatus: 'exported', currentExport: input.exportID },
          durationSeconds: current.durationSeconds,
          entryCount: current.entryCount,
          entryIds: entryIDs,
          reason: releaseReason,
          releasedAt: now,
          remoteStatus: verifiedRemoteStatus,
          remoteVerifiedAt: now,
          schemaVersion: 1,
          sourceExport: input.exportID,
        },
        depth: 0,
        overrideAccess: true,
        req,
      })
      for (const allocation of allocations.docs) {
        await session.payload.update({
          collection: 'invoice-export-entries',
          depth: 0,
          id: allocation.id,
          data: { releasedAt: now },
          overrideAccess: true,
          req,
        })
      }
      for (const entryID of entryIDs as string[]) {
        await session.payload.update({
          collection: 'time-entries',
          context: { [TIME_ENTRY_BILLING_MUTATION_CONTEXT]: 'release' },
          id: entryID,
          data: {
            billingStatus: 'unbilled',
            currentExport: null,
            exportedAt: null,
            reservedAt: null,
          },
          depth: 0,
          overrideAccess: true,
          req,
        })
      }
      await session.payload.update({
        collection: 'invoice-exports',
        id: input.exportID,
        data: {
          lastRemoteUpdateAt: now,
          releaseAction: release.id,
          releasedAt: now,
          remoteStatus: remote.status,
          state: 'released',
          stateHistory: history(current, 'released', String(session.user.id), {
            releaseAction: String(release.id),
          }),
        },
        depth: 0,
        overrideAccess: true,
        req,
      })
      await recordAuditEvent(
        session.payload,
        {
          actor: session.user.id,
          eventType: 'export.released',
          exportId: input.exportID,
          metadata: { entryCount: entryIDs.length, remoteStatus: remote.status },
          reason: releaseReason,
          targetCollection: 'invoice-exports',
          targetId: input.exportID,
          xeroInvoiceId: remote.invoiceID,
        },
        req,
      )
      return { entryIDs: entryIDs as string[], releaseID: String(release.id) }
    },
    { user: session.user },
  )
}

export async function deleteDraftInvoiceAndRelease(
  session: AppSession,
  input: { confirmation: string; exportID: string; reason: string },
  overrides: {
    client?: XeroAccountingClient
    token?: Awaited<ReturnType<typeof getValidAccountingAccessToken>>
  } = {},
): Promise<{ entryIDs: string[]; releaseID: string }> {
  assertOwnerAdmin(session)
  const deletionReason = reason(input.reason)
  const document = await session.payload.findByID({
    collection: 'invoice-exports',
    depth: 0,
    id: input.exportID,
    overrideAccess: true,
    req: session.req,
    showHiddenFields: true,
  })
  if (input.confirmation !== document.applicationReference) {
    throw new Error('Type the exact application reference to confirm deletion and release.')
  }

  const allocations = await loadExportAllocations(session, input.exportID)
  await assertLocallyReleasable(session, document, allocations)

  const runtime = overrides.client ? null : await resolveAccountingRuntime(session)
  const client = overrides.client ?? runtime?.client
  if (!client) throw new Error('Xero accounting is not configured.')
  let token =
    overrides.token ??
    (await getValidAccountingAccessToken(
      session,
      runtime ?? {
        client,
      },
    ))
  const tenantID = token.connection.tenantId
  if (!tenantID) throw new Error('The Xero tenant is unavailable.')

  const preflight = await fetchRemoteInvoiceForExport(session, document, client, token)
  let verified = preflight
  let deletionRequested = false
  let ambiguousRequest = false
  const operationID = `xdel-${stableHash({
    exportID: document.id,
    invoiceID: preflight.remote.invoiceID,
    operation: 'delete-draft-invoice',
    payloadHash: document.payloadHash,
  }).slice(0, 80)}`
  let postCorrelationID: string | undefined

  if (preflight.remote.status !== 'DELETED') {
    if (preflight.remote.status !== 'DRAFT') {
      throw new Error(
        `Xero currently reports ${preflight.remote.status}. Only a DRAFT invoice can be deleted and released by this action.`,
      )
    }
    if (stableHash(document.requestPayload) !== document.payloadHash) {
      throw new Error(
        'The immutable export payload no longer matches its saved hash. Deletion and release remain blocked.',
      )
    }
    if (!materiallyMatches(document, preflight.remote, allocations)) {
      throw new Error(
        'The Xero draft no longer exactly matches the immutable export snapshot. Deletion and release remain blocked.',
      )
    }
    await assertDeleteDraftCapability(session, tenantID)
    deletionRequested = true
    try {
      const postDelete = () =>
        client.accountingPost(
          token.accessToken,
          tenantID,
          `Invoices/${preflight.remote.invoiceID}`,
          {
            Invoices: [
              {
                InvoiceID: preflight.remote.invoiceID,
                Status: 'DELETED',
              },
            ],
          },
          operationID,
        )
      let response
      try {
        response = await postDelete()
      } catch (error) {
        if (
          overrides.token ||
          !(error instanceof AccountingIntegrationError) ||
          error.status !== 401
        ) {
          throw error
        }
        await requireMongoModel(session.payload, 'xero-connections').updateOne(
          { _id: token.connection.id, status: 'connected' },
          { $set: { accessTokenExpiresAt: new Date(0) } },
        )
        token = await getValidAccountingAccessToken(session, { client })
        if (token.connection.tenantId !== tenantID) {
          throw new AccountingIntegrationError(
            'wrong-tenant',
            'The refreshed Xero token does not match the pinned organisation.',
          )
        }
        response = await postDelete()
      }
      postCorrelationID = response.correlationID
    } catch (error) {
      if (!(error instanceof AccountingIntegrationError) || !error.requestMayHaveBeenSent) {
        throw error
      }
      ambiguousRequest = true
      postCorrelationID = error.correlationID
    }

    try {
      verified = await fetchRemoteInvoiceForExport(session, document, client, token)
    } catch (error) {
      throw new AccountingIntegrationError(
        'draft-delete-unverified',
        'Xero draft deletion could not be verified. The timesheets remain exported.',
        {
          cause: error,
          correlationID: postCorrelationID,
          requestMayHaveBeenSent: true,
          retryable: true,
        },
      )
    }
    if (verified.remote.status !== 'DELETED') {
      throw new AccountingIntegrationError(
        'draft-delete-not-confirmed',
        `Xero did not confirm deletion and currently reports ${verified.remote.status}. The timesheets remain exported.`,
        {
          correlationID: postCorrelationID ?? verified.response.correlationID,
          requestMayHaveBeenSent: true,
          retryable: true,
        },
      )
    }
  }

  const verifiedFetch: typeof fetchRemoteInvoiceForExport = async (_session, currentDocument) => {
    if (
      currentDocument.id !== document.id ||
      currentDocument.xeroInvoiceId !== verified.remote.invoiceID
    ) {
      throw new Error('The verified Xero invoice no longer matches this export.')
    }
    return verified
  }

  await recordAuditEvent(
    session.payload,
    {
      actor: session.user.id,
      correlationId:
        postCorrelationID ?? verified.response.correlationID ?? preflight.response.correlationID,
      eventType: 'export.reconciled',
      exportId: document.id,
      metadata: {
        action: 'xero-draft-delete-verified',
        ambiguousRequest,
        deletionRequested,
        operationId: operationID,
        preflightStatus: preflight.remote.status,
        verifiedStatus: verified.remote.status,
      },
      reason: deletionReason,
      targetCollection: 'invoice-exports',
      targetId: document.id,
      xeroInvoiceId: verified.remote.invoiceID,
    },
    session.req,
  )

  return releaseInvoiceExport(
    session,
    { ...input, reason: deletionReason },
    { client, fetchRemote: verifiedFetch },
  )
}

export async function cancelInvoiceExport(
  session: AppSession,
  input: { exportID: string; reason: string },
): Promise<void> {
  if (!hasActiveRole(session.user, ['owner', 'admin', 'biller']))
    throw new Error('Billing access is required.')
  const cancellationReason = reason(input.reason)
  const document = await session.payload.findByID({
    collection: 'invoice-exports',
    depth: 0,
    id: input.exportID,
    overrideAccess: true,
    req: session.req,
  })
  if (document.state !== 'preparing' && document.state !== 'queued') {
    throw new Error('Only an unsent preparing or queued export can be cancelled.')
  }
  const attemptID = relation(document.currentAttempt)
  if (!attemptID) throw new Error('The export attempt is unavailable.')
  const attempt = await session.payload.findByID({
    collection: 'xero-attempts',
    depth: 0,
    id: attemptID,
    overrideAccess: true,
    req: session.req,
    showHiddenFields: true,
  })
  if (attempt.requestMayHaveBeenSent || attempt.requestStartedAt) {
    throw new Error('Cancellation is blocked because a Xero request may already have started.')
  }
  if (document.jobId && !document.jobId.startsWith('attaching:')) {
    await session.payload.jobs.cancelByID({
      id: document.jobId,
      overrideAccess: true,
      req: session.req,
    })
  }
  await withPayloadTransaction(
    session.payload,
    async (req) => {
      const current = await session.payload.findByID({
        collection: 'invoice-exports',
        id: input.exportID,
        depth: 0,
        overrideAccess: true,
        req,
      })
      if (current.state !== 'preparing' && current.state !== 'queued')
        throw new Error('The export state changed before cancellation.')
      const currentAttempt = await session.payload.findByID({
        collection: 'xero-attempts',
        id: attemptID,
        depth: 0,
        overrideAccess: true,
        req,
        showHiddenFields: true,
      })
      if (currentAttempt.requestMayHaveBeenSent || currentAttempt.requestStartedAt)
        throw new Error('The Xero request has started; cancellation remains blocked.')
      const allocations = await session.payload.find({
        collection: 'invoice-export-entries',
        depth: 0,
        limit: 1_000,
        pagination: false,
        overrideAccess: true,
        req,
        where: { invoiceExport: { equals: input.exportID } },
      })
      for (const allocation of allocations.docs) {
        const entryID = relation(allocation.timeEntry)
        if (!entryID) continue
        const entry = await session.payload.findByID({
          collection: 'time-entries',
          id: entryID,
          depth: 0,
          overrideAccess: true,
          req,
        })
        if (
          entry.billingStatus === 'reserved' &&
          relation(entry.currentExport) === input.exportID
        ) {
          await session.payload.update({
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
            req,
          })
        }
      }
      const now = new Date().toISOString()
      await session.payload.update({
        collection: 'xero-attempts',
        id: attemptID,
        data: {
          completedAt: now,
          errorCode: 'cancelled-before-send',
          errorMessage: cancellationReason,
          result: 'definitely-not-created',
        },
        overrideAccess: true,
        req,
      })
      await session.payload.update({
        collection: 'invoice-exports',
        id: input.exportID,
        data: {
          cancelledAt: now,
          dispatchState: 'complete',
          lastErrorCode: 'cancelled-by-user',
          lastErrorMessage: cancellationReason,
          state: 'cancelled',
          stateHistory: history(current, 'cancelled', String(session.user.id)),
        },
        overrideAccess: true,
        req,
      })
      await recordAuditEvent(
        session.payload,
        {
          actor: session.user.id,
          eventType: 'export.state-changed',
          exportId: input.exportID,
          metadata: { to: 'cancelled' },
          reason: cancellationReason,
          targetCollection: 'invoice-exports',
          targetId: input.exportID,
        },
        req,
      )
    },
    { user: session.user },
  )
}

type QueueTask = (args: {
  input: { exportID: string }
  meta?: Record<string, unknown>
  queue: string
  task: 'create-xero-invoice' | 'reconcile-xero-invoice'
}) => Promise<{ id: number | string }>

export async function requestInvoiceReconciliation(
  session: AppSession,
  input: { exportID: string; reason: string },
): Promise<string> {
  assertOwnerAdmin(session)
  const reconciliationReason = reason(input.reason)
  const document = await session.payload.findByID({
    collection: 'invoice-exports',
    depth: 0,
    id: input.exportID,
    overrideAccess: true,
    req: session.req,
    showHiddenFields: true,
  })
  if (!['action-required', 'manual-review', 'reconciling'].includes(document.state)) {
    throw new Error('This export is not eligible for reconciliation.')
  }
  await session.payload.update({
    collection: 'invoice-exports',
    id: input.exportID,
    data: {
      nextAttemptAt: new Date().toISOString(),
      processingLeaseExpiresAt: null,
      processingLeaseId: null,
      state: 'reconciling',
      stateHistory: history(document, 'reconciling', String(session.user.id), { manual: true }),
    },
    overrideAccess: true,
    req: session.req,
  })
  const job = await (session.payload.jobs.queue as unknown as QueueTask)({
    input: { exportID: input.exportID },
    meta: { exportID: input.exportID, reason: 'manual-reconciliation' },
    queue: 'xero',
    task: 'reconcile-xero-invoice',
  })
  await session.payload.update({
    collection: 'invoice-exports',
    id: input.exportID,
    data: { jobId: String(job.id) },
    overrideAccess: true,
    req: session.req,
  })
  await recordAuditEvent(
    session.payload,
    {
      actor: session.user.id,
      eventType: 'export.retry-requested',
      exportId: input.exportID,
      reason: reconciliationReason,
      targetCollection: 'invoice-exports',
      targetId: input.exportID,
    },
    session.req,
  )
  return String(job.id)
}

export async function authorizeReplacementAttempt(
  session: AppSession,
  input: { confirmation: string; exportID: string; reason: string },
): Promise<string> {
  assertOwnerAdmin(session)
  const replacementReason = reason(input.reason)
  const document = await session.payload.findByID({
    collection: 'invoice-exports',
    depth: 0,
    id: input.exportID,
    overrideAccess: true,
    req: session.req,
    showHiddenFields: true,
  })
  if (
    document.state !== 'manual-review' ||
    document.lastErrorCode !== 'confirmed-absent-replacement-approval-required' ||
    input.confirmation !== document.applicationReference
  ) {
    throw new Error('A replacement attempt is not authorized for this export.')
  }
  const previousID = relation(document.currentAttempt)
  if (!previousID) throw new Error('The previous attempt is missing.')
  const attemptNumber = (document.currentAttemptNumber ?? 1) + 1
  const attempt = await session.payload.create({
    collection: 'xero-attempts',
    data: {
      attemptNumber,
      idempotencyKey: `xt-${stableHash({ exportID: input.exportID, nonce: randomUUID(), payloadHash: document.payloadHash }).slice(0, 80)}`,
      invoiceExport: input.exportID,
      method: 'POST',
      operation: 'create-invoice',
      payloadHash: document.payloadHash,
      replacesAttempt: previousID,
      requestMayHaveBeenSent: false,
      result: 'pending',
    },
    overrideAccess: true,
    req: session.req,
  })
  await session.payload.update({
    collection: 'invoice-exports',
    id: input.exportID,
    data: {
      currentAttempt: attempt.id,
      currentAttemptNumber: attemptNumber,
      lastErrorCode: null,
      lastErrorMessage: null,
      nextAttemptAt: new Date().toISOString(),
      state: 'retry-wait',
      stateHistory: history(document, 'retry-wait', String(session.user.id), {
        replacementAttempt: attemptNumber,
      }),
    },
    overrideAccess: true,
    req: session.req,
  })
  const job = await (session.payload.jobs.queue as unknown as QueueTask)({
    input: { exportID: input.exportID },
    meta: { exportID: input.exportID, reason: 'authorized-replacement' },
    queue: 'xero',
    task: 'create-xero-invoice',
  })
  await session.payload.update({
    collection: 'invoice-exports',
    id: input.exportID,
    data: { jobId: String(job.id) },
    overrideAccess: true,
    req: session.req,
  })
  await recordAuditEvent(
    session.payload,
    {
      actor: session.user.id,
      eventType: 'export.retry-requested',
      exportId: input.exportID,
      metadata: { attemptNumber },
      reason: replacementReason,
      targetCollection: 'invoice-exports',
      targetId: input.exportID,
    },
    session.req,
  )
  return String(job.id)
}

export async function acceptExistingInvoice(
  session: AppSession,
  input: { exportID: string; invoiceID: string; reason: string },
  overrides: { client?: XeroAccountingClient } = {},
): Promise<void> {
  assertOwnerAdmin(session)
  const acceptanceReason = reason(input.reason)
  if (!/^[0-9a-f-]{36}$/i.test(input.invoiceID)) throw new Error('Enter a valid Xero InvoiceID.')
  const document = await session.payload.findByID({
    collection: 'invoice-exports',
    depth: 0,
    id: input.exportID,
    overrideAccess: true,
    req: session.req,
    showHiddenFields: true,
  })
  if (document.state !== 'manual-review')
    throw new Error('Only a manual-review export can accept an existing invoice.')
  const runtime = overrides.client ? null : await resolveAccountingRuntime(session)
  const client = overrides.client ?? runtime?.client
  if (!client) throw new Error('Xero accounting is not configured.')
  const token = await getValidAccountingAccessToken(
    session,
    runtime ?? {
      client,
    },
  )
  if (!token.connection.tenantId) throw new Error('The Xero tenant is unavailable.')
  const response = await client.accountingGet(
    token.accessToken,
    token.connection.tenantId,
    `Invoices/${input.invoiceID}`,
  )
  const invoices = parseRemoteInvoices(response.data)
  const remote = invoices.length === 1 ? invoices[0] : undefined
  const allocations = (
    await session.payload.find({
      collection: 'invoice-export-entries',
      depth: 0,
      limit: 1_000,
      pagination: false,
      overrideAccess: true,
      req: session.req,
      sort: 'lineOrdinal',
      where: { invoiceExport: { equals: input.exportID } },
    })
  ).docs
  if (!remote || !materiallyMatches(document, remote, allocations))
    throw new Error(
      'The selected Xero invoice does not exactly match the immutable export snapshot.',
    )
  const previousID = relation(document.currentAttempt)
  const attemptNumber = (document.currentAttemptNumber ?? 1) + 1
  const attempt: XeroAttempt = await session.payload.create({
    collection: 'xero-attempts',
    data: {
      attemptNumber,
      idempotencyKey: `read-${stableHash({ exportID: input.exportID, invoiceID: input.invoiceID, nonce: randomUUID() }).slice(0, 80)}`,
      invoiceExport: input.exportID,
      method: 'GET',
      operation: 'fetch-invoice',
      payloadHash: document.payloadHash,
      replacesAttempt: previousID ?? undefined,
      requestMayHaveBeenSent: false,
      requestStartedAt: new Date().toISOString(),
      result: 'pending',
    },
    overrideAccess: true,
    req: session.req,
  })
  await session.payload.update({
    collection: 'invoice-exports',
    id: input.exportID,
    data: {
      currentAttempt: attempt.id,
      currentAttemptNumber: attemptNumber,
      xeroInvoiceId: remote.invoiceID,
    },
    overrideAccess: true,
    req: session.req,
  })
  await finalizeInvoiceSuccess({
    attempt,
    correlationID: response.correlationID,
    exportDocument: { ...document, currentAttempt: attempt.id, xeroInvoiceId: remote.invoiceID },
    payload: session.payload,
    rateLimitRemaining: response.rateLimitRemaining,
    remote,
    req: session.req,
  })
  await recordAuditEvent(
    session.payload,
    {
      actor: session.user.id,
      eventType: 'export.reconciled',
      exportId: input.exportID,
      metadata: { resolution: 'accepted-existing-invoice' },
      reason: acceptanceReason,
      targetCollection: 'invoice-exports',
      targetId: input.exportID,
      xeroInvoiceId: input.invoiceID,
    },
    session.req,
  )
}

export async function refreshExportForUser(
  session: AppSession,
  exportID: string,
): Promise<{ remoteStatus: string; state: string }> {
  assertOwnerAdmin(session)
  return refreshInvoiceExportStatus(session.req, exportID)
}
