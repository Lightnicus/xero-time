import {
  durationToQuantityScaled,
  quantityRateAmountScaled,
  scaledDecimal,
  taxForLine,
} from './math'
import { summarizeSelection } from './selection'
import { stableHash } from './stable'

import type {
  BillingPreview,
  BillingSettingsSnapshot,
  EligibleBillingEntry,
  InvoicePreview,
  PreviewLine,
} from './contracts'

const XERO_DESCRIPTION_MAX = 4_000
const XERO_REFERENCE_MAX = 255
const MAX_LINES_PER_INVOICE = 1_000
const CUSTOMER_REFERENCE_CODE = /^(?=.{1,30}$)[A-Z0-9]+(?:-[A-Z0-9]+)*$/

const groupKey = (entry: EligibleBillingEntry): string =>
  `${entry.customerID}\u0000${entry.currency}`

const formatLineDescription = (template: string, entry: EligibleBillingEntry): string => {
  const values: Record<string, string> = {
    description: entry.description,
    projectCode: entry.projectCode,
    projectName: entry.projectName,
    userName: entry.userName,
    workDate: entry.workDate,
  }
  const description = template.replace(
    /{{\s*([^{}]+?)\s*}}/g,
    (_, token: string) => values[token] ?? '',
  )
  if (!description.includes(entry.description)) {
    throw new Error('The line template must preserve the complete time-entry description.')
  }
  if (description.length > XERO_DESCRIPTION_MAX) {
    throw new Error(
      `Invoice line for entry ${entry.entryID} is ${description.length} characters; Xero permits ${XERO_DESCRIPTION_MAX}. No text was truncated.`,
    )
  }
  return description
}

const addDays = (calendarDate: string, days: number): string => {
  const date = new Date(`${calendarDate}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function dueDateFor(
  invoiceDate: string,
  terms: BillingSettingsSnapshot['paymentTerms'],
): string {
  if (terms.basis === 'days-after-invoice') return addDays(invoiceDate, terms.value)

  const date = new Date(`${invoiceDate}T00:00:00.000Z`)
  const nextMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 2, 0))
  nextMonth.setUTCDate(Math.min(terms.value, nextMonth.getUTCDate()))
  return nextMonth.toISOString().slice(0, 10)
}

const previewLine = (
  entry: EligibleBillingEntry,
  lineOrdinal: number,
  settings: BillingSettingsSnapshot,
): PreviewLine => {
  const quantityScaled = durationToQuantityScaled(entry.durationSeconds)
  const amountScaled = quantityRateAmountScaled(quantityScaled, entry.rateScaled)
  const taxScaled = taxForLine(amountScaled, entry.taxRatePercent, settings.lineAmountType)
  return {
    ...entry,
    amountScaled,
    lineDescription: formatLineDescription(settings.invoiceLineDescriptionTemplate, entry),
    lineOrdinal,
    quantityScaled,
    taxScaled,
  }
}

export function buildBillingPreview(input: {
  batchReference: string
  entries: readonly EligibleBillingEntry[]
  invoiceDate: string
  settings: BillingSettingsSnapshot
}): BillingPreview {
  if (input.entries.length === 0) throw new Error('There are no eligible entries to preview.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.invoiceDate))
    throw new Error('Choose a valid invoice date.')
  if (!/^[A-Z0-9_-]{6,80}$/.test(input.batchReference))
    throw new Error('The preview reference is invalid.')

  const groups = new Map<string, EligibleBillingEntry[]>()
  for (const entry of input.entries) {
    const values = groups.get(groupKey(entry)) ?? []
    values.push(entry)
    groups.set(groupKey(entry), values)
  }

  const invoices: InvoicePreview[] = [...groups.values()].map((entries) => {
    if (entries.length > MAX_LINES_PER_INVOICE) {
      throw new Error(
        `A prospective invoice has ${entries.length} lines; narrow the selection to ${MAX_LINES_PER_INVOICE} or fewer.`,
      )
    }
    const first = entries[0]
    if (!first) throw new Error('The invoice group is empty.')
    if (
      !CUSTOMER_REFERENCE_CODE.test(first.customerReferenceCode) ||
      !Number.isSafeInteger(first.customerReferenceSequence) ||
      first.customerReferenceSequence < 1 ||
      !Number.isSafeInteger(first.customerReferenceStartNumber) ||
      first.customerReferenceStartNumber < 1 ||
      (first.customerReferenceLastSequence !== null &&
        (!Number.isSafeInteger(first.customerReferenceLastSequence) ||
          first.customerReferenceLastSequence < 1 ||
          first.customerReferenceLastSequence < first.customerReferenceStartNumber ||
          first.customerReferenceLastSequence >= Number.MAX_SAFE_INTEGER))
    ) {
      throw new Error('The customer invoice reference configuration is invalid.')
    }
    const expectedSequence = Math.max(
      first.customerReferenceStartNumber,
      (first.customerReferenceLastSequence ?? 0) + 1,
    )
    if (first.customerReferenceSequence !== expectedSequence) {
      throw new Error('The customer invoice reference sequence is stale.')
    }
    if (
      entries.some(
        (entry) =>
          entry.customerID !== first.customerID ||
          entry.customerReferenceCode !== first.customerReferenceCode ||
          entry.customerReferenceLastSequence !== first.customerReferenceLastSequence ||
          entry.customerReferenceSequence !== first.customerReferenceSequence ||
          entry.customerReferenceStartNumber !== first.customerReferenceStartNumber,
      )
    ) {
      throw new Error('The invoice group contains inconsistent customer reference data.')
    }
    const applicationReference = `${first.customerReferenceCode}-${String(first.customerReferenceSequence).padStart(4, '0')}`
    if (applicationReference.length > XERO_REFERENCE_MAX) {
      throw new Error(
        `The application reference exceeds Xero's ${XERO_REFERENCE_MAX}-character boundary.`,
      )
    }
    const lines = entries.map((entry, ordinal) => previewLine(entry, ordinal, input.settings))
    const subtotalScaled = lines.reduce((total, line) => total + line.amountScaled, 0)
    const taxScaled = lines.reduce((total, line) => total + line.taxScaled, 0)
    const totalScaled =
      input.settings.lineAmountType === 'Inclusive' ? subtotalScaled : subtotalScaled + taxScaled
    const dueDate = dueDateFor(input.invoiceDate, input.settings.paymentTerms)
    const payload = {
      Contact: { ContactID: first.contactID },
      CurrencyCode: first.currency,
      Date: input.invoiceDate,
      DueDate: dueDate,
      LineAmountTypes: input.settings.lineAmountType,
      LineItems: lines.map((line) => ({
        AccountCode: line.accountCode,
        Description: line.lineDescription,
        ItemCode: line.itemCode,
        Quantity: scaledDecimal(line.quantityScaled),
        TaxType: line.taxType,
        Tracking: line.tracking.map((item) => ({ Name: item.name, Option: item.option })),
        UnitAmount: scaledDecimal(line.rateScaled),
      })),
      Reference: applicationReference,
      Status: 'DRAFT',
      Type: 'ACCREC',
    }
    return {
      applicationReference,
      contactID: first.contactID,
      contactName: first.contactName,
      currency: first.currency,
      customerID: first.customerID,
      customerReferenceCode: first.customerReferenceCode,
      customerReferenceLastSequence: first.customerReferenceLastSequence,
      customerReferenceSequence: first.customerReferenceSequence,
      customerReferenceStartNumber: first.customerReferenceStartNumber,
      dueDate,
      durationSeconds: lines.reduce((total, line) => total + line.durationSeconds, 0),
      entryCount: lines.length,
      invoiceDate: input.invoiceDate,
      lines,
      payload,
      payloadHash: stableHash(payload),
      subtotalScaled,
      taxScaled,
      totalScaled,
    }
  })

  const selectionIdentity = input.entries.map((entry) => ({
    accountCode: entry.accountCode,
    contactID: entry.contactID,
    currency: entry.currency,
    customerID: entry.customerID,
    customerReferenceCode: entry.customerReferenceCode,
    customerReferenceLastSequence: entry.customerReferenceLastSequence,
    customerReferenceSequence: entry.customerReferenceSequence,
    customerReferenceStartNumber: entry.customerReferenceStartNumber,
    entryID: entry.entryID,
    itemCode: entry.itemCode,
    itemID: entry.itemID,
    itemName: entry.itemName,
    taxType: entry.taxType,
    tracking: entry.tracking,
    updatedAt: entry.updatedAt,
  }))
  const selectionHash = stableHash(selectionIdentity)
  return {
    batchReference: input.batchReference,
    checksum: stableHash({
      batchReference: input.batchReference,
      invoiceDate: input.invoiceDate,
      invoices: invoices.map((invoice) => ({
        customerID: invoice.customerID,
        customerReferenceCode: invoice.customerReferenceCode,
        customerReferenceLastSequence: invoice.customerReferenceLastSequence,
        customerReferenceSequence: invoice.customerReferenceSequence,
        customerReferenceStartNumber: invoice.customerReferenceStartNumber,
        payloadHash: invoice.payloadHash,
      })),
      selectionHash,
      settings: input.settings,
    }),
    invoices,
    selectionHash,
    settings: input.settings,
    summary: summarizeSelection(input.entries),
  }
}
