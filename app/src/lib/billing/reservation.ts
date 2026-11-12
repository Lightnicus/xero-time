import 'server-only'

import { randomUUID } from 'node:crypto'

import { hasActiveRole } from '@/access/roles'
import { TIME_ENTRY_BILLING_MUTATION_CONTEXT } from '@/collections/TimeEntries'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AppSession } from '@/lib/member-app/session'
import { requireMongoModel } from '@/lib/payload/mongo'
import { withPayloadTransaction } from '@/lib/payload/withTransaction'

import { dispatchInvoiceExport, runExportJobWithTimeout } from './dispatch'
import { getBillingEligibility } from './eligibility'
import { buildBillingPreview } from './preview'
import { normalizeBillingSelection, selectEligibleEntries } from './selection'
import { stableHash } from './stable'

import type { BillingPreview, BillingSelection, InvoicePreview } from './contracts'

type BillingMongoSession = AppSession['payload']['db']['sessions'][string]

export type ConfirmBillingInput = {
  batchReference: string
  checksum: string
  invoiceDate: string
  modeOverrideReason?: string
  requestedMode: 'background' | 'wait-for-result'
  selection: BillingSelection
}

export type BillingReservationResult = {
  actualMode: 'background' | 'wait-for-result'
  batchID: string
  exportIDs: string[]
  /** `dispatch-pending`: reserved and saved, but job attachment failed; the dispatcher retries. */
  status: 'continuing-in-background' | 'dispatch-pending' | 'queued'
}

const batchReference = (): string => randomUUID().toUpperCase()

const stalePreviewError = (): Error =>
  new Error('The billing data changed after preview. Refresh and review the updated invoices.')

const claimCustomerReference = async (
  session: AppSession,
  invoice: InvoicePreview,
  mongoSession: BillingMongoSession,
): Promise<void> => {
  const claimed = await requireMongoModel(session.payload, 'customers').findOneAndUpdate(
    {
      _id: invoice.customerID,
      invoiceReferenceCode: invoice.customerReferenceCode,
      invoiceReferenceStartNumber: invoice.customerReferenceStartNumber,
      lastInvoiceReferenceSequence: invoice.customerReferenceLastSequence,
    },
    { $set: { lastInvoiceReferenceSequence: invoice.customerReferenceSequence } },
    { new: true, session: mongoSession },
  )
  if (!claimed) throw stalePreviewError()
}

export async function createBillingPreview(
  session: AppSession,
  input: {
    batchReference?: string
    invoiceDate: string
    selection: BillingSelection
  },
): Promise<BillingPreview> {
  if (!hasActiveRole(session.user, ['owner', 'admin', 'biller']))
    throw new Error('Billing access is required.')
  const selection = normalizeBillingSelection(input.selection)
  const eligibility = await getBillingEligibility(
    session,
    selection.filter,
    selection.type === 'explicit' ? { entryIDs: selection.explicitEntryIDs } : {},
  )
  const entries = selectEligibleEntries(eligibility, selection)
  return buildBillingPreview({
    batchReference: input.batchReference ?? batchReference(),
    entries,
    invoiceDate: input.invoiceDate,
    settings: eligibility.settings,
  })
}

const executionMode = (
  session: AppSession,
  input: ConfirmBillingInput,
  settings: Record<string, unknown>,
  preview: BillingPreview,
): {
  actual: 'background' | 'wait-for-result'
  reason?: string
  requested: 'background' | 'wait-for-result'
} => {
  const configured =
    settings.xeroExportMode === 'wait-for-result' ? 'wait-for-result' : 'background'
  const tooLarge =
    preview.summary.invoiceCount > Number(settings.maxWaitInvoices ?? 1) ||
    preview.summary.entryCount > Number(settings.maxWaitLines ?? 50)
  const waitAvailable = settings.waitForResultEnabled === true && !tooLarge
  // The mode the server runs without any user choice: the configured mode, downgraded to
  // background when waiting is off or this batch exceeds the wait limits.
  const serverChoice =
    configured === 'wait-for-result' && waitAvailable ? 'wait-for-result' : 'background'
  let requested = input.requestedMode
  // Asking for the configured mode, or for the mode the server would fall back to anyway, is not
  // an override and must not demand a reason.
  const override = requested !== configured && requested !== serverChoice
  if (override) {
    const billerCanOverride =
      session.user.role !== 'biller' || settings.allowBillerModeOverride === true
    if (!billerCanOverride) requested = configured
    else if ((input.modeOverrideReason?.trim().length ?? 0) < 10) {
      throw new Error('Explain why this export should use a different execution mode.')
    }
  }
  const actual = requested === 'wait-for-result' && waitAvailable ? 'wait-for-result' : 'background'
  return {
    actual,
    reason: override ? input.modeOverrideReason?.trim() : undefined,
    requested,
  }
}

export async function confirmBillingPreview(
  session: AppSession,
  input: ConfirmBillingInput,
  overrides: { dispatch?: typeof dispatchInvoiceExport } = {},
): Promise<BillingReservationResult> {
  if (!hasActiveRole(session.user, ['owner', 'admin', 'biller']))
    throw new Error('Billing access is required.')
  const selection = normalizeBillingSelection(input.selection)

  const transactionResult = await withPayloadTransaction(
    session.payload,
    async (req) => {
      const transactionID = await req.transactionID
      const mongoSession = transactionID ? session.payload.db.sessions[transactionID] : undefined
      if (!mongoSession) {
        throw new Error('A transaction is required to reserve an invoice reference.')
      }
      const transactionSession: AppSession = { ...session, req }
      const eligibility = await getBillingEligibility(
        transactionSession,
        selection.filter,
        selection.type === 'explicit' ? { entryIDs: selection.explicitEntryIDs } : {},
      )
      if (eligibility.settingsDocument.acceptingNewExports !== true) {
        throw new Error('New exports are currently paused by the owner.')
      }
      const selectedEntries = selectEligibleEntries(eligibility, selection)
      const preview = buildBillingPreview({
        batchReference: input.batchReference,
        entries: selectedEntries,
        invoiceDate: input.invoiceDate,
        settings: eligibility.settings,
      })
      if (preview.checksum !== input.checksum) {
        throw stalePreviewError()
      }
      const mode = executionMode(transactionSession, input, eligibility.settingsDocument, preview)
      for (const invoice of preview.invoices) {
        await claimCustomerReference(transactionSession, invoice, mongoSession)
      }
      const now = new Date().toISOString()
      const totalAmountScaled = preview.invoices.reduce(
        (sum, invoice) => sum + invoice.totalScaled,
        0,
      )
      const batch = await session.payload.create({
        collection: 'export-batches',
        data: {
          actualMode: mode.actual,
          applicationReference: `BATCH-${input.batchReference}`,
          durationSeconds: preview.summary.durationSeconds,
          entryCount: preview.summary.entryCount,
          explicitEntryIds: selection.type === 'explicit' ? selection.explicitEntryIDs : undefined,
          invoiceCount: preview.summary.invoiceCount,
          normalizedFilterSnapshot: {
            excludedEntryIDs: selection.excludedEntryIDs,
            filter: selection.filter,
            sort: ['customer', 'currency', 'workDate', 'project', 'user', 'id'],
          },
          requestedBy: session.user.id,
          requestedMode: mode.requested,
          schemaVersion: 1,
          selectionType: selection.type,
          snapshotHash: preview.checksum,
          status: 'preparing',
          totalAmountScaled,
        },
        depth: 0,
        overrideAccess: true,
        req,
      })
      const exportIDs: string[] = []

      for (const invoice of preview.invoices) {
        const firstLine = invoice.lines[0]
        if (!firstLine) throw new Error('An invoice preview cannot be saved without a line.')
        const rebillSources = await session.payload.find({
          collection: 'invoice-export-entries',
          depth: 0,
          limit: invoice.lines.length,
          overrideAccess: true,
          pagination: false,
          req,
          sort: '-releasedAt',
          where: {
            and: [
              { timeEntry: { in: invoice.lines.map((line) => line.entryID) } },
              { releasedAt: { exists: true } },
            ],
          },
        })
        const rebillSourceIDs = [
          ...new Set(rebillSources.docs.map((item) => String(item.invoiceExport))),
        ]
        const invoiceExport = await session.payload.create({
          collection: 'invoice-exports',
          data: {
            actualMode: mode.actual,
            applicationReference: invoice.applicationReference,
            batch: batch.id,
            currency: invoice.currency,
            customerReferenceCode: invoice.customerReferenceCode,
            customerReferenceSequence: invoice.customerReferenceSequence,
            currentAttemptNumber: 1,
            customer: firstLine.customerID,
            dispatchState: 'pending',
            dueDate: `${invoice.dueDate}T00:00:00.000Z`,
            durationSeconds: invoice.durationSeconds,
            entryCount: invoice.entryCount,
            invoiceDate: `${invoice.invoiceDate}T00:00:00.000Z`,
            modeOverrideReason: mode.reason,
            payloadHash: invoice.payloadHash,
            rebillOf: rebillSourceIDs.length === 1 ? (rebillSourceIDs[0] ?? null) : null,
            requestPayload: invoice.payload,
            requestedBy: session.user.id,
            requestedMode: mode.requested,
            schemaVersion: 1,
            selectionHash: preview.selectionHash,
            state: 'preparing',
            stateHistory: [
              { actor: String(session.user.id), at: now, from: null, to: 'preparing' },
            ],
            subtotalScaled: invoice.subtotalScaled,
            taxScaled: invoice.taxScaled,
            totalScaled: invoice.totalScaled,
          },
          depth: 0,
          overrideAccess: true,
          req,
        })
        const exportID = String(invoiceExport.id)
        exportIDs.push(exportID)
        const idempotencyKey = `xt-${stableHash({ applicationReference: invoice.applicationReference, payloadHash: invoice.payloadHash }).slice(0, 80)}`
        const attempt = await session.payload.create({
          collection: 'xero-attempts',
          data: {
            attemptNumber: 1,
            idempotencyKey,
            invoiceExport: exportID,
            method: 'POST',
            operation: 'create-invoice',
            payloadHash: invoice.payloadHash,
            requestMayHaveBeenSent: false,
            result: 'pending',
          },
          depth: 0,
          overrideAccess: true,
          req,
        })
        await session.payload.update({
          collection: 'invoice-exports',
          id: exportID,
          data: { currentAttempt: attempt.id },
          depth: 0,
          overrideAccess: true,
          req,
        })

        for (const line of invoice.lines) {
          await session.payload.create({
            collection: 'invoice-export-entries',
            data: {
              accountCode: line.accountCode,
              amountScaled: line.amountScaled,
              currency: line.currency,
              customer: line.customerID,
              description: line.description,
              durationSeconds: line.durationSeconds,
              invoiceExport: exportID,
              itemCode: line.itemCode,
              itemName: line.itemName,
              lineOrdinal: line.lineOrdinal,
              project: line.projectID,
              projectCode: line.projectCode,
              projectName: line.projectName,
              quantityScaled: line.quantityScaled,
              rateScaled: line.rateScaled,
              schemaVersion: 1,
              taxScaled: line.taxScaled,
              taxType: line.taxType,
              timeEntry: line.entryID,
              timezone: line.timezone,
              tracking: line.tracking,
              user: line.userID,
              userName: line.userName,
              workDate: line.workDate,
              xeroItemId: line.itemID,
            },
            depth: 0,
            overrideAccess: true,
            req,
          })
          await session.payload.update({
            collection: 'time-entries',
            context: { [TIME_ENTRY_BILLING_MUTATION_CONTEXT]: 'reserve' },
            id: line.entryID,
            data: {
              billingStatus: 'reserved',
              currentExport: exportID,
              exportedAt: null,
              reservedAt: now,
            },
            depth: 0,
            overrideAccess: true,
            req,
          })
        }
        await recordAuditEvent(
          session.payload,
          {
            actor: session.user.id,
            customerId: invoice.lines[0]?.customerID,
            eventType: rebillSourceIDs.length === 1 ? 'export.rebilled' : 'export.created',
            exportId: exportID,
            metadata: {
              actualMode: mode.actual,
              entryCount: invoice.entryCount,
              requestedMode: mode.requested,
            },
            targetCollection: 'invoice-exports',
            targetId: exportID,
          },
          req,
        )
      }
      return { actualMode: mode.actual, batchID: String(batch.id), exportIDs }
    },
    { user: session.user },
  )

  // Everything below runs after the reservation committed. A failure here must not be reported as
  // if nothing happened: the exports stay 'preparing' and the durable dispatcher attaches their jobs.
  const dispatch = overrides.dispatch ?? dispatchInvoiceExport
  const logPostCommitFailure = (step: string, error: unknown): void => {
    session.payload.logger.error({
      batchID: transactionResult.batchID,
      err: error,
      msg: `Billing reservation committed but ${step} failed; the dispatcher will retry.`,
    })
  }
  const jobs: string[] = []
  let dispatchFailed = false
  for (const exportID of transactionResult.exportIDs) {
    try {
      const result = await dispatch(session.payload, exportID, session.req)
      if (result.jobID) jobs.push(result.jobID)
    } catch (error) {
      dispatchFailed = true
      logPostCommitFailure('job dispatch', error)
    }
  }
  const allDispatched = !dispatchFailed && jobs.length === transactionResult.exportIDs.length
  try {
    await session.payload.update({
      collection: 'export-batches',
      id: transactionResult.batchID,
      data: { status: allDispatched ? 'queued' : 'preparing' },
      depth: 0,
      overrideAccess: true,
      req: session.req,
    })
  } catch (error) {
    // The batch stays 'preparing'; export processing recomputes the batch status later.
    logPostCommitFailure('the batch status update', error)
  }
  if (dispatchFailed) return { ...transactionResult, status: 'dispatch-pending' }
  if (transactionResult.actualMode === 'wait-for-result' && jobs.length === 1) {
    try {
      const status = await runExportJobWithTimeout(session.payload, jobs[0] as string, session.req)
      return { ...transactionResult, status: status === 'completed' ? 'queued' : status }
    } catch (error) {
      logPostCommitFailure('the wait-for-result run', error)
      return { ...transactionResult, status: 'continuing-in-background' }
    }
  }
  return { ...transactionResult, status: 'queued' }
}
