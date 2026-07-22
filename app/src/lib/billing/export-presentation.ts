import type { InvoiceExport } from '@/payload-types'

const EXPORT_STATE_LABELS: Record<InvoiceExport['state'], string> = {
  'action-required': 'Action needed',
  cancelled: 'Cancelled',
  'manual-review': 'Review needed',
  preparing: 'Preparing',
  processing: 'Sending to Xero',
  queued: 'Queued',
  reconciling: 'Checking Xero',
  released: 'Released for rebilling',
  'retry-wait': 'Retry scheduled',
  succeeded: 'Completed',
}

const XERO_INVOICE_STATUS_LABELS: Record<string, string> = {
  AUTHORISED: 'Approved · awaiting payment',
  DELETED: 'Deleted',
  DRAFT: 'Draft',
  PAID: 'Paid',
  SUBMITTED: 'Awaiting approval',
  VOIDED: 'Voided',
}

export const exportStateLabel = (state: InvoiceExport['state']): string =>
  EXPORT_STATE_LABELS[state]

export const xeroInvoiceStatusLabel = (status: string | null | undefined): string =>
  status ? (XERO_INVOICE_STATUS_LABELS[status] ?? status) : 'Not yet known'
