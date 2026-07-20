import { describe, expect, it } from 'vitest'

import {
  BILLING_BLOCKER_CODES,
  type BillingBlocker,
  type BlockedBillingEntry,
} from '@/lib/billing/contracts'
import {
  billingBlockerActionLabel,
  billingBlockerLabel,
  summarizeBillingRemediation,
  xeroConnectionBlockers,
} from '@/lib/billing/remediation'

const blockedEntry = (entryID: string, blockers: BillingBlocker[]): BlockedBillingEntry => ({
  amountScaled: 0,
  blockers,
  customerID: 'customer-1',
  customerName: 'Example Customer',
  description: `Entry ${entryID}`,
  durationSeconds: 3_600,
  entryID,
  projectCode: 'WEB',
  projectID: 'project-1',
  projectName: 'Website',
  rateScaled: 1_500_000,
  timezone: 'Pacific/Auckland',
  updatedAt: '2026-07-20T00:00:00.000Z',
  userID: 'user-1',
  userName: 'Test User',
  workDate: '2026-07-20',
})

describe('billing blocker remediation', () => {
  it('aggregates organisation setup once and leaves only row-specific blockers on entries', () => {
    const globalBlockers: BillingBlocker[] = [
      {
        code: 'missing-xero-capability',
        message: 'Refresh Xero data.',
        remediationHref: '/app/settings/xero',
      },
      {
        code: 'missing-account',
        message: 'Choose a revenue account.',
        remediationHref: '/app/settings/billing',
      },
      {
        code: 'missing-tax',
        message: 'Choose a tax type.',
        remediationHref: '/app/settings/billing',
      },
    ]
    const result = summarizeBillingRemediation([
      blockedEntry('entry-1', [
        ...globalBlockers,
        {
          code: 'invalid-duration',
          message: 'Duration must be a whole number of minutes.',
          remediationHref: '/app/time/entry-1/edit',
        },
      ]),
      blockedEntry('entry-2', globalBlockers),
    ])

    expect(result.setupIssues.map(({ code, entryCount }) => ({ code, entryCount }))).toEqual([
      { code: 'missing-xero-capability', entryCount: 2 },
      { code: 'missing-account', entryCount: 2 },
      { code: 'missing-tax', entryCount: 2 },
    ])
    expect(result.entrySpecific).toHaveLength(1)
    expect(result.entrySpecific[0]?.entryID).toBe('entry-1')
    expect(result.entrySpecific[0]?.blockers.map((item) => item.code)).toEqual(['invalid-duration'])
  })

  it('keeps invalid project or customer overrides on their entry and aggregates invalid defaults', () => {
    const result = summarizeBillingRemediation([
      blockedEntry('project-override', [
        {
          code: 'invalid-account',
          message: 'Inactive revenue account.',
          remediationHref: '/admin/collections/projects/project-1',
        },
      ]),
      blockedEntry('global-default', [
        {
          code: 'invalid-tax',
          message: 'Inactive tax type.',
          remediationHref: '/app/settings/billing',
        },
      ]),
    ])

    expect(result.setupIssues.map((item) => item.code)).toEqual(['invalid-tax'])
    expect(result.entrySpecific.map((item) => item.entryID)).toEqual(['project-override'])
  })

  it('does not report a missing capability when Xero is disconnected', () => {
    expect(xeroConnectionBlockers(null, false).map((item) => item.code)).toEqual([
      'xero-not-connected',
    ])
    expect(xeroConnectionBlockers('tenant-1', false).map((item) => item.code)).toEqual([
      'missing-xero-capability',
    ])
    expect(xeroConnectionBlockers('tenant-1', true)).toEqual([])
  })

  it('provides human-readable labels and action copy instead of exposing machine codes', () => {
    for (const code of BILLING_BLOCKER_CODES) expect(billingBlockerLabel(code)).not.toBe(code)
    expect(billingBlockerActionLabel('unmapped-contact')).toBe('Map customer')
    expect(billingBlockerActionLabel('invalid-duration')).toBe('Edit time entry')
    expect(billingBlockerActionLabel('missing-customer-reference')).toBe('Set invoice reference')
    expect(billingBlockerActionLabel('missing-item')).toBe('Choose Xero item')
    expect(billingBlockerActionLabel('invalid-item')).toBe('Review Xero item')
  })
})
