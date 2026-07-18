'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import type { BillingBlockerCode, BillingFilter, BillingSelection } from '@/lib/billing/contracts'
import {
  acceptExistingInvoice,
  authorizeReplacementAttempt,
  cancelInvoiceExport,
  refreshExportForUser,
  releaseInvoiceExport,
  requestInvoiceReconciliation,
} from '@/lib/billing/export-actions'
import { confirmBillingPreview } from '@/lib/billing/reservation'
import { normalizeBillingFilter } from '@/lib/billing/selection'
import { createSelectionToken, readSelectionToken } from '@/lib/billing/selection-token'
import { isValidCalendarDate } from '@/lib/domain/validation'
import { requireAppSession } from '@/lib/member-app/session'
import { enforceRateLimit, rateLimitKey } from '@/lib/security/rate-limit'
import { prepareXeroQueue } from '@/lib/xero/export/maintenance'

const value = (formData: FormData, name: string): string => {
  const item = formData.get(name)
  return typeof item === 'string' ? item : ''
}

const values = (formData: FormData, name: string): string[] =>
  formData.getAll(name).filter((item): item is string => typeof item === 'string')

const commandSession = async (
  roles: ('admin' | 'biller' | 'owner')[] = ['owner', 'admin', 'biller'],
) => {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, roles)) redirect('/app')
  await enforceRateLimit(session.payload, {
    key: rateLimitKey(await headers(), String(session.user.id)),
    limit: 30,
    scope: 'command.billing',
    windowMs: 15 * 60_000,
  })
  return session
}

const formFilter = (formData: FormData): BillingFilter =>
  normalizeBillingFilter({
    blocker: value(formData, 'blocker') as BillingBlockerCode,
    currency: value(formData, 'currency'),
    customerID: value(formData, 'customerID'),
    dateFrom: value(formData, 'dateFrom'),
    dateTo: value(formData, 'dateTo'),
    projectID: value(formData, 'projectID'),
    timezone: value(formData, 'timezone'),
    userID: value(formData, 'userID'),
  })

export async function startBillingPreviewAction(formData: FormData): Promise<void> {
  await commandSession()
  try {
    const invoiceDate = value(formData, 'invoiceDate')
    if (!isValidCalendarDate(invoiceDate)) throw new Error('Choose a valid invoice date.')
    const type = value(formData, 'selectionType') === 'all-matching' ? 'all-matching' : 'explicit'
    const selected = values(formData, 'selectedEntryID')
    const visible = values(formData, 'visibleEligibleID')
    const selectedSet = new Set(selected)
    const selection: BillingSelection = {
      excludedEntryIDs: type === 'all-matching' ? visible.filter((id) => !selectedSet.has(id)) : [],
      explicitEntryIDs: selected,
      filter: formFilter(formData),
      type,
    }
    const token = createSelectionToken({ invoiceDate, selection })
    redirect(`/app/billing/preview?selection=${encodeURIComponent(token)}`)
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error
    redirect('/app/billing?status=invalid-selection')
  }
}

export async function allUninvoicedPreviewAction(formData: FormData): Promise<void> {
  await commandSession()
  const invoiceDate = value(formData, 'invoiceDate')
  if (!isValidCalendarDate(invoiceDate)) redirect('/app/billing?status=invalid-selection')
  const token = createSelectionToken({
    invoiceDate,
    selection: {
      excludedEntryIDs: [],
      explicitEntryIDs: [],
      filter: normalizeBillingFilter({ timezone: value(formData, 'timezone') }),
      type: 'all-matching',
    },
  })
  redirect(`/app/billing/preview?selection=${encodeURIComponent(token)}`)
}

export async function confirmBillingExportAction(formData: FormData): Promise<void> {
  const session = await commandSession()
  let batchID: string
  try {
    const envelope = readSelectionToken(value(formData, 'selectionToken'))
    const result = await confirmBillingPreview(session, {
      batchReference: value(formData, 'batchReference'),
      checksum: value(formData, 'checksum'),
      invoiceDate: envelope.invoiceDate,
      modeOverrideReason: value(formData, 'modeOverrideReason'),
      requestedMode:
        value(formData, 'requestedMode') === 'wait-for-result' ? 'wait-for-result' : 'background',
      selection: envelope.selection,
    })
    batchID = result.batchID
  } catch {
    redirect(
      `/app/billing/preview?selection=${encodeURIComponent(value(formData, 'selectionToken'))}&status=stale-or-failed`,
    )
  }
  revalidatePath('/app/billing')
  redirect(`/app/billing/exports?batch=${encodeURIComponent(batchID)}&status=created`)
}

export async function cancelExportAction(formData: FormData): Promise<void> {
  const session = await commandSession()
  const exportID = value(formData, 'exportID')
  try {
    await cancelInvoiceExport(session, { exportID, reason: value(formData, 'reason') })
  } catch {
    redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=cancel-failed`)
  }
  revalidatePath('/app/billing')
  redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=cancelled`)
}

export async function refreshExportAction(formData: FormData): Promise<void> {
  const session = await commandSession(['owner', 'admin'])
  const exportID = value(formData, 'exportID')
  try {
    await refreshExportForUser(session, exportID)
  } catch {
    redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=refresh-failed`)
  }
  revalidatePath(`/app/billing/exports/${exportID}`)
  redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=refreshed`)
}

export async function reconcileExportAction(formData: FormData): Promise<void> {
  const session = await commandSession(['owner', 'admin'])
  const exportID = value(formData, 'exportID')
  try {
    await requestInvoiceReconciliation(session, {
      exportID,
      reason: value(formData, 'reason'),
    })
  } catch {
    redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=reconcile-failed`)
  }
  revalidatePath(`/app/billing/exports/${exportID}`)
  redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=reconciling`)
}

export async function releaseExportAction(formData: FormData): Promise<void> {
  const session = await commandSession(['owner', 'admin'])
  const exportID = value(formData, 'exportID')
  try {
    await releaseInvoiceExport(session, {
      confirmation: value(formData, 'confirmation'),
      exportID,
      reason: value(formData, 'reason'),
    })
  } catch {
    redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=release-failed`)
  }
  revalidatePath('/app/billing')
  redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=released`)
}

export async function authorizeReplacementAction(formData: FormData): Promise<void> {
  const session = await commandSession(['owner', 'admin'])
  const exportID = value(formData, 'exportID')
  try {
    await authorizeReplacementAttempt(session, {
      confirmation: value(formData, 'confirmation'),
      exportID,
      reason: value(formData, 'reason'),
    })
  } catch {
    redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=replacement-failed`)
  }
  redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=retrying`)
}

export async function acceptExistingInvoiceAction(formData: FormData): Promise<void> {
  const session = await commandSession(['owner', 'admin'])
  const exportID = value(formData, 'exportID')
  try {
    await acceptExistingInvoice(session, {
      exportID,
      invoiceID: value(formData, 'invoiceID'),
      reason: value(formData, 'reason'),
    })
  } catch {
    redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=accept-failed`)
  }
  redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=reconciled`)
}

export async function runXeroQueueNowAction(): Promise<void> {
  const session = await commandSession(['owner', 'admin'])
  try {
    await prepareXeroQueue(session.payload, session.req)
    await session.payload.jobs.run({
      limit: 5,
      overrideAccess: true,
      processingOrder: 'createdAt',
      queue: 'xero',
      req: session.req,
      sequential: true,
      silent: true,
    })
  } catch {
    redirect('/app/billing/exports?status=queue-failed')
  }
  revalidatePath('/app/billing/exports')
  redirect('/app/billing/exports?status=queue-ran')
}
