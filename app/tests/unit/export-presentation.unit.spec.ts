import { describe, expect, it } from 'vitest'

import {
  exportStateLabel,
  isAwaitingXeroReconnect,
  xeroInvoiceStatusLabel,
} from '@/lib/billing/export-presentation'
import type { InvoiceExport } from '@/payload-types'

describe('export status presentation', () => {
  it.each([
    ['preparing', 'Preparing'],
    ['queued', 'Queued'],
    ['processing', 'Sending to Xero'],
    ['retry-wait', 'Retry scheduled'],
    ['action-required', 'Action needed'],
    ['reconciling', 'Checking Xero'],
    ['succeeded', 'Completed'],
    ['cancelled', 'Cancelled'],
    ['released', 'Released for rebilling'],
    ['manual-review', 'Review needed'],
  ] satisfies Array<[InvoiceExport['state'], string]>)('labels %s as %s', (state, label) => {
    expect(exportStateLabel(state)).toBe(label)
  })

  it('labels an export paused for a Xero reconnect as waiting', () => {
    expect(exportStateLabel('retry-wait', 'xero-reconnect-required')).toBe('Waiting for Xero')
    expect(exportStateLabel('reconciling', 'xero-reconnect-required')).toBe('Waiting for Xero')
    expect(exportStateLabel('retry-wait', 'accounting-post-http-500')).toBe('Retry scheduled')
    expect(
      isAwaitingXeroReconnect({ lastErrorCode: 'xero-reconnect-required', state: 'succeeded' }),
    ).toBe(false)
  })

  it.each([
    ['DRAFT', 'Draft'],
    ['SUBMITTED', 'Awaiting approval'],
    ['AUTHORISED', 'Approved · awaiting payment'],
    ['PAID', 'Paid'],
    ['DELETED', 'Deleted'],
    ['VOIDED', 'Voided'],
  ])('labels Xero status %s as %s', (status, label) => {
    expect(xeroInvoiceStatusLabel(status)).toBe(label)
  })

  it('preserves an unknown Xero status and handles a missing status', () => {
    expect(xeroInvoiceStatusLabel('NEW_XERO_STATUS')).toBe('NEW_XERO_STATUS')
    expect(xeroInvoiceStatusLabel(null)).toBe('Not yet known')
  })
})
