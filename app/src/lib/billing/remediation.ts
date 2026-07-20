import type { BillingBlocker, BillingBlockerCode, BlockedBillingEntry } from './contracts'

const BILLING_SETUP_BLOCKER_CODES = [
  'xero-not-connected',
  'missing-xero-capability',
  'missing-account',
  'invalid-account',
  'missing-tax',
  'invalid-tax',
  'unsupported-currency',
] as const satisfies readonly BillingBlockerCode[]

export type BillingSetupBlockerCode = (typeof BILLING_SETUP_BLOCKER_CODES)[number]

export type BillingSetupAction = 'billing-settings' | 'refresh-xero' | 'xero-settings'

export type BillingSetupIssue = {
  action: BillingSetupAction
  actionLabel: string
  code: BillingSetupBlockerCode
  description: string
  entryCount: number
  title: string
}

const blockerLabels: Record<BillingBlockerCode, string> = {
  'active-reservation': 'Already reserved for export',
  'archived-contact': 'Xero contact is archived',
  'currency-conflict': 'Currencies do not match',
  'invalid-account': 'Revenue account needs review',
  'invalid-currency': 'Invalid currency',
  'invalid-duration': 'Invalid duration',
  'invalid-item': 'Xero item needs review',
  'invalid-tax': 'Tax type needs review',
  'invalid-tracking': 'Tracking settings need review',
  'missing-account': 'Revenue account required',
  'missing-customer': 'Customer is missing',
  'missing-customer-reference': 'Customer invoice reference required',
  'missing-item': 'Xero item required',
  'missing-project': 'Project is missing',
  'missing-rate': 'Hourly rate required',
  'missing-tax': 'Tax type required',
  'missing-xero-capability': 'Refresh Xero invoice permissions',
  'not-billable': 'Not marked billable',
  'not-unbilled': 'Already exported',
  'stale-contact': 'Xero contact needs refreshing',
  'stale-source-data': 'Source data needs review',
  'unmapped-contact': 'Customer is not mapped to Xero',
  'unsupported-currency': 'Currency is not enabled in Xero',
  'xero-not-connected': 'Connect Xero',
}

const blockerActionLabels: Partial<Record<BillingBlockerCode, string>> = {
  'active-reservation': 'View export',
  'archived-contact': 'Review customer mapping',
  'invalid-account': 'Review revenue account',
  'invalid-duration': 'Edit time entry',
  'invalid-item': 'Review Xero item',
  'invalid-tax': 'Review tax type',
  'invalid-tracking': 'Review project tracking',
  'missing-account': 'Choose revenue account',
  'missing-customer-reference': 'Set invoice reference',
  'missing-item': 'Choose Xero item',
  'missing-rate': 'Review project rate',
  'missing-tax': 'Choose tax type',
  'missing-xero-capability': 'Refresh Xero data',
  'stale-contact': 'Refresh customer mapping',
  'stale-source-data': 'Review source data',
  'unmapped-contact': 'Map customer',
  'unsupported-currency': 'Refresh Xero data',
  'xero-not-connected': 'Connect Xero',
}

const setupPresentation: Record<
  BillingSetupBlockerCode,
  Omit<BillingSetupIssue, 'code' | 'entryCount'>
> = {
  'invalid-account': {
    action: 'billing-settings',
    actionLabel: 'Review revenue account',
    description: 'The selected revenue account is not active in the connected Xero organisation.',
    title: 'Revenue account needs review',
  },
  'invalid-tax': {
    action: 'billing-settings',
    actionLabel: 'Review tax type',
    description: 'The selected tax type is not active in the connected Xero organisation.',
    title: 'Tax type needs review',
  },
  'missing-account': {
    action: 'billing-settings',
    actionLabel: 'Choose revenue account',
    description:
      'Choose the Xero revenue account to use when a customer or project does not override it.',
    title: 'Revenue account required',
  },
  'missing-tax': {
    action: 'billing-settings',
    actionLabel: 'Choose tax type',
    description: 'Choose the Xero tax type to use when a customer or project does not override it.',
    title: 'Tax type required',
  },
  'missing-xero-capability': {
    action: 'refresh-xero',
    actionLabel: 'Refresh Xero data',
    description:
      'Xero is connected, but draft-invoice permission has not been confirmed by the latest reference-data refresh.',
    title: 'Refresh Xero invoice permissions',
  },
  'unsupported-currency': {
    action: 'refresh-xero',
    actionLabel: 'Refresh Xero data',
    description:
      'At least one entry uses a currency that is not enabled in the connected Xero organisation.',
    title: 'Currency is not enabled in Xero',
  },
  'xero-not-connected': {
    action: 'xero-settings',
    actionLabel: 'Connect Xero',
    description: 'Connect a Xero organisation before invoice previews can be created.',
    title: 'Xero connection required',
  },
}

const setupCodes = new Set<BillingBlockerCode>(BILLING_SETUP_BLOCKER_CODES)

export const billingBlockerLabel = (code: BillingBlockerCode): string => blockerLabels[code]

export const billingBlockerActionLabel = (code: BillingBlockerCode): string =>
  blockerActionLabels[code] ?? 'Review issue'

export const isBillingSetupBlocker = (
  blocker: BillingBlocker,
): blocker is BillingBlocker & { code: BillingSetupBlockerCode } => {
  if (!setupCodes.has(blocker.code)) return false
  if (blocker.code === 'invalid-account' || blocker.code === 'invalid-tax') {
    return blocker.remediationHref === '/app/settings/billing'
  }
  return true
}

export const xeroConnectionBlockers = (
  tenantID: string | null,
  capabilityAvailable: boolean,
): BillingBlocker[] => {
  if (!tenantID) {
    return [
      {
        code: 'xero-not-connected',
        message: 'Connect the Xero accounting organisation.',
        remediationHref: '/app/settings/xero',
      },
    ]
  }
  if (capabilityAvailable) return []
  return [
    {
      code: 'missing-xero-capability',
      message: 'Refresh Xero data to confirm draft-invoice capability.',
      remediationHref: '/app/settings/xero',
    },
  ]
}

export const summarizeBillingRemediation = (
  blockedEntries: BlockedBillingEntry[],
): { entrySpecific: BlockedBillingEntry[]; setupIssues: BillingSetupIssue[] } => {
  const counts = new Map<BillingSetupBlockerCode, number>()
  const entrySpecific: BlockedBillingEntry[] = []

  for (const entry of blockedEntries) {
    const setupCodesForEntry = new Set<BillingSetupBlockerCode>()
    const entryBlockers = entry.blockers.filter((item) => {
      if (!isBillingSetupBlocker(item)) return true
      setupCodesForEntry.add(item.code)
      return false
    })
    for (const code of setupCodesForEntry) counts.set(code, (counts.get(code) ?? 0) + 1)
    if (entryBlockers.length > 0) entrySpecific.push({ ...entry, blockers: entryBlockers })
  }

  const setupIssues = BILLING_SETUP_BLOCKER_CODES.flatMap((code) => {
    const entryCount = counts.get(code) ?? 0
    return entryCount > 0 ? [{ code, entryCount, ...setupPresentation[code] }] : []
  })

  return { entrySpecific, setupIssues }
}
