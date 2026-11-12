'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import type { BillingBlockerCode, BillingFilter, BillingSelection } from '@/lib/billing/contracts'
import {
  acceptExistingInvoice,
  authorizeReplacementAttempt,
  cancelInvoiceExport,
  deleteDraftInvoiceAndRelease,
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
import { refreshXeroReferenceData } from '@/lib/xero/accounting/reference-data'
import { prepareXeroQueue } from '@/lib/xero/export/maintenance'

const value = (formData: FormData, name: string): string => {
  const item = formData.get(name)
  return typeof item === 'string' ? item : ''
}

const values = (formData: FormData, name: string): string[] =>
  formData.getAll(name).filter((item): item is string => typeof item === 'string')

const commandSession = async () => {
  const session = await requireAppSession()
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

export async function refreshBillingReferenceDataAction(): Promise<void> {
  const session = await commandSession()
  let status = 'reference-refresh-failed'
  try {
    const result = await refreshXeroReferenceData(session)
    status = result.capabilityAvailable ? 'references-refreshed' : 'xero-capability-missing'
  } catch {
    // The status message on the billing page gives the user a safe retry path.
  }
  revalidatePath('/app/billing')
  revalidatePath('/app/settings/billing')
  revalidatePath('/app/settings/xero')
  redirect(`/app/billing?status=${status}`)
}

export async function confirmBillingExportAction(formData: FormData): Promise<void> {
  const session = await commandSession()
  let result: Awaited<ReturnType<typeof confirmBillingPreview>>
  try {
    const envelope = readSelectionToken(value(formData, 'selectionToken'))
    // Throws only before or during the reservation transaction (nothing was saved); failures after
    // the commit are reported through `result.status` instead.
    result = await confirmBillingPreview(session, {
      batchReference: value(formData, 'batchReference'),
      checksum: value(formData, 'checksum'),
      invoiceDate: envelope.invoiceDate,
      requestedMode:
        value(formData, 'requestedMode') === 'wait-for-result' ? 'wait-for-result' : 'background',
      selection: envelope.selection,
    })
  } catch {
    redirect(
      `/app/billing/preview?selection=${encodeURIComponent(value(formData, 'selectionToken'))}&status=stale-or-failed`,
    )
  }
  revalidatePath('/app/billing')
  revalidatePath('/app/billing/exports')
  const status = result.status === 'dispatch-pending' ? 'dispatch-pending' : 'created'
  redirect(`/app/billing/exports?batch=${encodeURIComponent(result.batchID)}&status=${status}`)
}

export async function cancelExportAction(formData: FormData): Promise<void> {
  const session = await commandSession()
  const exportID = value(formData, 'exportID')
  try {
    await cancelInvoiceExport(session, { exportID })
  } catch {
    redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=cancel-failed`)
  }
  revalidatePath('/app/billing')
  redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=cancelled`)
}

export async function refreshExportAction(formData: FormData): Promise<void> {
  const session = await commandSession()
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
  const session = await commandSession()
  const exportID = value(formData, 'exportID')
  try {
    await requestInvoiceReconciliation(session, { exportID })
  } catch {
    redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=reconcile-failed`)
  }
  revalidatePath(`/app/billing/exports/${exportID}`)
  redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=reconciling`)
}

export async function releaseExportAction(formData: FormData): Promise<void> {
  const session = await commandSession()
  const exportID = value(formData, 'exportID')
  try {
    await releaseInvoiceExport(session, { exportID })
  } catch {
    redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=release-failed`)
  }
  revalidatePath('/app/billing')
  redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=released`)
}

export async function deleteDraftAndReleaseExportAction(formData: FormData): Promise<void> {
  const session = await commandSession()
  const exportID = value(formData, 'exportID')
  try {
    await deleteDraftInvoiceAndRelease(session, { exportID })
  } catch {
    redirect(
      `/app/billing/exports/${encodeURIComponent(exportID)}?status=draft-delete-release-failed`,
    )
  }
  revalidatePath('/app/billing')
  revalidatePath('/app/billing/exports')
  redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=draft-deleted-and-released`)
}

export async function authorizeReplacementAction(formData: FormData): Promise<void> {
  const session = await commandSession()
  const exportID = value(formData, 'exportID')
  try {
    await authorizeReplacementAttempt(session, { exportID })
  } catch {
    redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=replacement-failed`)
  }
  redirect(`/app/billing/exports/${encodeURIComponent(exportID)}?status=retrying`)
}

export async function acceptExistingInvoiceAction(formData: FormData): Promise<void> {
  const session = await commandSession()
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
  const session = await commandSession()
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
