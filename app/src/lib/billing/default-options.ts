import type { XeroReferenceDatum } from '@/payload-types'

export type BillingDefaultOption = {
  label: string
  value: string
}

export type BillingDefaultField = 'accountCode' | 'taxType'

export type BillingDefaultInput = {
  accountCode: string
  taxRequired: boolean
  taxType: string
}

type BillingReference = Pick<
  XeroReferenceDatum,
  'code' | 'metadata' | 'name' | 'resourceType' | 'status' | 'type'
>

const REVENUE_ACCOUNT_TYPES = new Set(['OTHERINCOME', 'REVENUE', 'SALES'])

const metadataRecord = (value: BillingReference['metadata']): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}

const normalizedCode = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toUpperCase() : ''

export const isRevenueAccountReference = (reference: BillingReference): boolean => {
  if (
    reference.resourceType !== 'account' ||
    reference.status !== 'active' ||
    normalizedCode(reference.code) === ''
  ) {
    return false
  }

  const accountType = normalizedCode(reference.type)
  const accountClass = normalizedCode(metadataRecord(reference.metadata).class)

  return REVENUE_ACCOUNT_TYPES.has(accountType) || accountClass === 'REVENUE'
}

export const isRevenueTaxReference = (reference: BillingReference): boolean =>
  reference.resourceType === 'tax-rate' &&
  reference.status === 'active' &&
  normalizedCode(reference.code) !== '' &&
  metadataRecord(reference.metadata).canApplyToRevenue === true

const taxRate = (reference: BillingReference): number | null => {
  const metadata = metadataRecord(reference.metadata)
  const value =
    typeof metadata.displayTaxRate === 'number'
      ? metadata.displayTaxRate
      : typeof metadata.effectiveRate === 'number'
        ? metadata.effectiveRate
        : null

  return value !== null && Number.isFinite(value) ? value : null
}

const formatRate = (value: number): string =>
  new Intl.NumberFormat('en', { maximumFractionDigits: 4 }).format(value)

export const buildRevenueAccountOptions = (
  references: readonly BillingReference[],
): BillingDefaultOption[] =>
  references
    .filter(isRevenueAccountReference)
    .map((reference) => {
      const code = normalizedCode(reference.code)
      return {
        label: `${code} — ${reference.name}`,
        value: code,
      }
    })
    .sort((left, right) => left.label.localeCompare(right.label))

export const buildRevenueTaxOptions = (
  references: readonly BillingReference[],
): BillingDefaultOption[] =>
  references
    .filter(isRevenueTaxReference)
    .map((reference) => {
      const code = normalizedCode(reference.code)
      const rate = taxRate(reference)
      return {
        label: `${reference.name} — ${code}${rate === null ? '' : ` (${formatRate(rate)}%)`}`,
        value: code,
      }
    })
    .sort((left, right) => left.label.localeCompare(right.label))

export const billingDefaultFieldErrors = (
  input: BillingDefaultInput,
): Partial<Record<BillingDefaultField, string>> => {
  const errors: Partial<Record<BillingDefaultField, string>> = {}

  if (normalizedCode(input.accountCode) === '') {
    errors.accountCode = 'Choose a revenue account.'
  }
  if (input.taxRequired && normalizedCode(input.taxType) === '') {
    errors.taxType = 'Choose a tax type.'
  }

  return errors
}
