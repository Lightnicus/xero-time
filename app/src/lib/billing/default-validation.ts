import { AccountingIntegrationError } from '@/lib/xero/accounting/contracts'

import { isRevenueAccountReference, isRevenueTaxReference } from './default-options'

import type { PayloadRequest } from 'payload'

/**
 * Validate invoice defaults at the Payload schema boundary. This module avoids
 * Next's `server-only` marker because Payload config is also loaded by CLI and
 * test processes outside the Next bundler.
 */
export async function validateXeroBillingDefaults(
  req: PayloadRequest,
  values: {
    accountCode?: null | string
    taxType?: null | string
  },
): Promise<void> {
  const accountCode = values.accountCode?.trim().toUpperCase() ?? ''
  const taxType = values.taxType?.trim().toUpperCase() ?? ''
  if (!accountCode && !taxType) return

  const connection = await req.payload.find({
    collection: 'xero-connections',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [
        { singletonKey: { equals: 'business-accounting' } },
        { status: { equals: 'connected' } },
      ],
    },
  })
  const tenantID = connection.docs[0]?.tenantId
  if (!tenantID) {
    throw new AccountingIntegrationError(
      'invalid-billing-defaults',
      'Connect a Xero organisation before selecting invoice defaults.',
    )
  }

  const [account, tax] = await Promise.all([
    accountCode
      ? req.payload.find({
          collection: 'xero-reference-data',
          depth: 0,
          limit: 1,
          overrideAccess: true,
          req,
          where: {
            and: [
              { sourceTenantId: { equals: tenantID } },
              { resourceType: { equals: 'account' } },
              { code: { equals: accountCode } },
              { status: { equals: 'active' } },
            ],
          },
        })
      : Promise.resolve(null),
    taxType
      ? req.payload.find({
          collection: 'xero-reference-data',
          depth: 0,
          limit: 1,
          overrideAccess: true,
          req,
          where: {
            and: [
              { sourceTenantId: { equals: tenantID } },
              { resourceType: { equals: 'tax-rate' } },
              { code: { equals: taxType } },
              { status: { equals: 'active' } },
            ],
          },
        })
      : Promise.resolve(null),
  ])
  if (
    (accountCode && (!account?.docs[0] || !isRevenueAccountReference(account.docs[0]))) ||
    (taxType && (!tax?.docs[0] || !isRevenueTaxReference(tax.docs[0])))
  ) {
    throw new AccountingIntegrationError(
      'invalid-billing-defaults',
      'Select an active revenue account and revenue-compatible tax rate from the connected Xero organisation.',
    )
  }
}
