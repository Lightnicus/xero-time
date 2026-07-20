export const BILLING_BLOCKER_CODES = [
  'not-billable',
  'not-unbilled',
  'active-reservation',
  'invalid-duration',
  'missing-rate',
  'invalid-currency',
  'currency-conflict',
  'missing-project',
  'missing-customer',
  'missing-customer-reference',
  'stale-source-data',
  'unmapped-contact',
  'archived-contact',
  'stale-contact',
  'missing-item',
  'invalid-item',
  'missing-account',
  'invalid-account',
  'missing-tax',
  'invalid-tax',
  'invalid-tracking',
  'unsupported-currency',
  'missing-xero-capability',
  'xero-not-connected',
] as const

export type BillingBlockerCode = (typeof BILLING_BLOCKER_CODES)[number]

export type BillingBlocker = {
  code: BillingBlockerCode
  message: string
  remediationHref?: string
}

export type BillingFilter = {
  blocker?: BillingBlockerCode
  currency?: string
  customerID?: string
  dateFrom?: string
  dateTo?: string
  projectID?: string
  timezone: string
  userID?: string
}

export type BillingTrackingItem = {
  name: string
  option: string
  trackingCategoryID?: string
  trackingOptionID?: string
}

export type BillingEntryBase = {
  amountScaled: number
  customerID: string
  customerName: string
  description: string
  durationSeconds: number
  entryID: string
  projectCode: string
  projectID: string
  projectName: string
  rateScaled: number
  timezone: string
  updatedAt: string
  userID: string
  userName: string
  workDate: string
}

export type EligibleBillingEntry = BillingEntryBase & {
  accountCode: string
  contactID: string
  contactName: string
  currency: string
  customerReferenceCode: string
  customerReferenceLastSequence: number | null
  customerReferenceSequence: number
  customerReferenceStartNumber: number
  itemCode: string
  itemID: string
  itemName: string
  taxRatePercent: number
  taxType: string
  tracking: BillingTrackingItem[]
}

export type BlockedBillingEntry = BillingEntryBase & {
  blockers: BillingBlocker[]
  currency?: string
}

export type BillingEligibilityResult = {
  blocked: BlockedBillingEntry[]
  eligible: EligibleBillingEntry[]
  generatedAt: string
}

export type BillingSelection = {
  excludedEntryIDs: string[]
  explicitEntryIDs: string[]
  filter: BillingFilter
  type: 'all-matching' | 'explicit'
}

export type BillingSelectionSummary = {
  amountScaled: number
  currencies: string[]
  durationSeconds: number
  entryCount: number
  invoiceCount: number
  newestWorkDate?: string
  oldestWorkDate?: string
}

export type BillingSettingsSnapshot = {
  defaultRevenueAccountCode: string
  defaultTaxType: string
  invoiceLineDescriptionTemplate: string
  lineAmountType: 'Exclusive' | 'Inclusive' | 'NoTax'
  paymentTerms: {
    basis: 'day-of-following-month' | 'days-after-invoice'
    value: number
  }
}

export type PreviewLine = EligibleBillingEntry & {
  lineDescription: string
  lineOrdinal: number
  quantityScaled: number
  taxScaled: number
}

export type InvoicePreview = {
  applicationReference: string
  contactID: string
  contactName: string
  currency: string
  customerID: string
  customerReferenceCode: string
  customerReferenceLastSequence: number | null
  customerReferenceSequence: number
  customerReferenceStartNumber: number
  dueDate: string
  durationSeconds: number
  entryCount: number
  invoiceDate: string
  lines: PreviewLine[]
  payload: Record<string, unknown>
  payloadHash: string
  subtotalScaled: number
  taxScaled: number
  totalScaled: number
}

export type BillingPreview = {
  batchReference: string
  checksum: string
  invoices: InvoicePreview[]
  selectionHash: string
  settings: BillingSettingsSnapshot
  summary: BillingSelectionSummary
}
