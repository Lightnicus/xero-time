import 'server-only'

import {
  buildRevenueAccountOptions,
  buildRevenueTaxOptions,
  type BillingDefaultOption,
} from '@/lib/billing/default-options'
import type { AppSession } from '@/lib/member-app/session'

export type BillingDefaultSettingsView = {
  accountOptions: BillingDefaultOption[]
  configuredAccountCode: string
  configuredAccountValid: boolean
  configuredTaxType: string
  configuredTaxValid: boolean
  connected: boolean
  lastReferenceDataSyncAt: null | string
  lineAmountType: 'Exclusive' | 'Inclusive' | 'NoTax'
  taxOptions: BillingDefaultOption[]
  taxRequired: boolean
  tenantName: null | string
}

const code = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toUpperCase() : ''

export async function getBillingDefaultSettingsView(
  session: AppSession,
): Promise<BillingDefaultSettingsView> {
  const [settings, connectionResult] = await Promise.all([
    session.payload.findGlobal({
      slug: 'billing-settings',
      overrideAccess: false,
      req: session.req,
    }),
    session.payload.find({
      collection: 'xero-connections',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req: session.req,
      where: {
        and: [
          { singletonKey: { equals: 'business-accounting' } },
          { status: { equals: 'connected' } },
        ],
      },
    }),
  ])
  const connection = connectionResult.docs[0]
  const tenantID = connection?.tenantId
  const configuredAccountCode = code(settings.defaultRevenueAccountCode)
  const configuredTaxType = code(settings.defaultTaxType)
  const lineAmountType = settings.lineAmountType

  if (!tenantID) {
    return {
      accountOptions: [],
      configuredAccountCode,
      configuredAccountValid: false,
      configuredTaxType,
      configuredTaxValid: false,
      connected: false,
      lastReferenceDataSyncAt: connection?.lastReferenceDataSyncAt ?? null,
      lineAmountType,
      taxOptions: [],
      taxRequired: lineAmountType !== 'NoTax',
      tenantName: connection?.tenantName ?? null,
    }
  }

  const references = await session.payload.find({
    collection: 'xero-reference-data',
    depth: 0,
    limit: 2_000,
    overrideAccess: true,
    pagination: false,
    req: session.req,
    sort: ['resourceType', 'code'],
    where: {
      and: [
        { sourceTenantId: { equals: tenantID } },
        { resourceType: { in: ['account', 'tax-rate'] } },
        { status: { equals: 'active' } },
      ],
    },
  })
  const accountOptions = buildRevenueAccountOptions(references.docs)
  const taxOptions = buildRevenueTaxOptions(references.docs)

  return {
    accountOptions,
    configuredAccountCode,
    configuredAccountValid: accountOptions.some((option) => option.value === configuredAccountCode),
    configuredTaxType,
    configuredTaxValid: taxOptions.some((option) => option.value === configuredTaxType),
    connected: true,
    lastReferenceDataSyncAt: connection.lastReferenceDataSyncAt ?? null,
    lineAmountType,
    taxOptions,
    taxRequired: lineAmountType !== 'NoTax',
    tenantName: connection.tenantName ?? null,
  }
}
