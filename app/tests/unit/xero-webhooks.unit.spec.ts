// @vitest-environment node

import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { AccountingIntegrationError } from '@/lib/xero/accounting/contracts'
import {
  classifyExportFailure,
  materiallyMatches,
  remoteDerivedValuesHash,
  remoteDerivedValuesMatchAttempt,
} from '@/lib/xero/export/processor'
import { parseXeroWebhookEvents, validXeroWebhookSignature } from '@/lib/xero/export/webhooks'
import type { InvoiceExport, InvoiceExportEntry } from '@/payload-types'

const key = 'webhook-test-key-that-is-long-enough-for-tests'

describe('Xero webhook boundary', () => {
  it('validates the exact raw body with constant-length HMAC material', () => {
    const body = '{"events":[]}'
    const signature = createHmac('sha256', key).update(body, 'utf8').digest('base64')
    expect(validXeroWebhookSignature(body, signature, key)).toBe(true)
    expect(validXeroWebhookSignature(`${body} `, signature, key)).toBe(false)
    expect(validXeroWebhookSignature(body, 'invalid', key)).toBe(false)
    expect(validXeroWebhookSignature(body, signature, undefined)).toBe(false)
  })

  it('accepts Xero intent-to-receive and parses bounded invoice events', () => {
    expect(parseXeroWebhookEvents('{"events":[]}')).toEqual([])
    expect(
      parseXeroWebhookEvents(
        JSON.stringify({
          events: [
            {
              eventCategory: 'INVOICE',
              eventDateUtc: '2026-07-18T10:00:00.000Z',
              eventType: 'UPDATE',
              resourceId: 'invoice-id',
              tenantId: 'tenant-id',
            },
          ],
        }),
      ),
    ).toEqual([
      {
        eventAt: '2026-07-18T10:00:00.000Z',
        eventType: 'UPDATE',
        resourceID: 'invoice-id',
        resourceType: 'INVOICE',
        tenantID: 'tenant-id',
      },
    ])
  })

  it('rejects malformed, incomplete, oversized, and overlong event batches', () => {
    expect(() => parseXeroWebhookEvents('not-json')).toThrow()
    expect(() => parseXeroWebhookEvents('{"events":[{}]}')).toThrow()
    expect(() =>
      parseXeroWebhookEvents(JSON.stringify({ events: Array.from({ length: 101 }, () => ({})) })),
    ).toThrow()
    expect(() =>
      parseXeroWebhookEvents(`{"events":[],"padding":"${'x'.repeat(300_000)}"}`),
    ).toThrow()
  })
})

describe('Xero export retry classification', () => {
  it('distinguishes definite, retryable, and possibly-sent outcomes', () => {
    expect(
      classifyExportFailure(
        new AccountingIntegrationError('validation', 'safe', { status: 400 }),
        false,
      ),
    ).toBe('action-required')
    expect(
      classifyExportFailure(
        new AccountingIntegrationError('validation', 'safe', { status: 400 }),
        true,
      ),
    ).toBe('action-required')
    expect(
      classifyExportFailure(
        new AccountingIntegrationError('limited', 'safe', { status: 429 }),
        false,
      ),
    ).toBe('retry-wait')
    expect(
      classifyExportFailure(
        new AccountingIntegrationError('network', 'safe', { retryable: true }),
        false,
      ),
    ).toBe('retry-wait')
    expect(
      classifyExportFailure(
        new AccountingIntegrationError('timeout', 'safe', { requestMayHaveBeenSent: true }),
        false,
      ),
    ).toBe('reconciling')
    expect(classifyExportFailure(new AccountingIntegrationError('worker', 'safe'), true)).toBe(
      'reconciling',
    )
  })
})

describe('Xero export material comparison', () => {
  it('keeps legacy snapshots compatible when neither line contains an ItemCode', () => {
    const legacyLine = {
      AccountCode: '200',
      Description: 'Legacy professional time',
      Quantity: 1,
      TaxType: 'OUTPUT2',
      Tracking: [],
      UnitAmount: 150,
    }
    const exportDocument = {
      applicationReference: 'LEGACY-0001',
      requestPayload: {
        Contact: { ContactID: '11111111-1111-4111-8111-111111111111' },
        CurrencyCode: 'NZD',
        LineItems: [legacyLine],
        Reference: 'LEGACY-0001',
      },
      subtotalScaled: 1_500_000,
      totalScaled: 1_725_000,
    } as unknown as InvoiceExport

    expect(
      materiallyMatches(
        exportDocument,
        {
          contactID: '11111111-1111-4111-8111-111111111111',
          currency: 'NZD',
          invoiceID: '22222222-2222-4222-8222-222222222222',
          lineAmountType: 'Exclusive',
          lineItemIDs: ['33333333-3333-4333-8333-333333333333'],
          lineItems: [{ ...legacyLine, DiscountRate: 0 }],
          reference: 'LEGACY-0001',
          status: 'DRAFT',
          subtotal: 150,
          total: 172.5,
        },
        [{} as InvoiceExportEntry],
      ),
    ).toBe(true)
  })

  it('ignores derived Xero totals while matching each immutable line at four-decimal precision', () => {
    const lines = [
      {
        AccountCode: '200',
        Description: 'First seventeen minutes of professional time',
        ItemCode: 'TIME',
        Quantity: 0.2833,
        TaxType: 'OUTPUT2',
        Tracking: [
          { Name: 'Region', Option: 'North' },
          { Name: 'Team', Option: 'Delivery' },
        ],
        UnitAmount: 150,
      },
      {
        AccountCode: '200',
        Description: 'Second seventeen minutes of professional time',
        ItemCode: 'TIME',
        Quantity: 0.2833,
        TaxType: 'OUTPUT2',
        Tracking: [
          { Name: 'Region', Option: 'North' },
          { Name: 'Team', Option: 'Delivery' },
        ],
        UnitAmount: 150,
      },
    ]
    const exportDocument = {
      applicationReference: 'PRECISION-0001',
      requestPayload: {
        Contact: { ContactID: '11111111-1111-4111-8111-111111111111' },
        CurrencyCode: 'NZD',
        LineAmountTypes: 'Exclusive',
        LineItems: lines,
        Reference: 'PRECISION-0001',
      },
      subtotalScaled: 849_900,
      totalScaled: 977_386,
    } as unknown as InvoiceExport

    const remote = {
      contactID: '11111111-1111-4111-8111-111111111111',
      currency: 'NZD',
      invoiceID: '22222222-2222-4222-8222-222222222222',
      lineAmountType: 'Exclusive',
      lineItemIDs: ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'],
      lineItems: [
        { ...lines[0], Tracking: [...lines[0]!.Tracking].reverse() },
        { ...lines[1], Tracking: [...lines[1]!.Tracking].reverse() },
      ],
      reference: 'PRECISION-0001',
      status: 'AUTHORISED',
      subtotal: 85,
      total: 97.74,
    }
    const allocations = [{} as InvoiceExportEntry, {} as InvoiceExportEntry]

    expect(materiallyMatches(exportDocument, remote, allocations)).toBe(true)
    expect(
      materiallyMatches(exportDocument, { ...remote, lineAmountType: 'Inclusive' }, allocations),
    ).toBe(false)
    expect(
      materiallyMatches(exportDocument, { ...remote, lineAmountType: undefined }, allocations),
    ).toBe(false)
    expect(
      materiallyMatches(
        exportDocument,
        {
          ...remote,
          lineItems: [lines[0]!, { ...lines[1]!, DiscountRate: 5 }],
        },
        allocations,
      ),
    ).toBe(false)
    expect(
      materiallyMatches(
        exportDocument,
        {
          ...remote,
          lineItems: [remote.lineItems[0]!, { ...remote.lineItems[1]!, DiscountAmount: 5 }],
        },
        allocations,
      ),
    ).toBe(false)
    expect(
      materiallyMatches(
        exportDocument,
        {
          ...remote,
          lineItemIDs: [...remote.lineItemIDs, 'extra'],
          lineItems: [...remote.lineItems, {}],
        },
        [...allocations, {} as InvoiceExportEntry],
      ),
    ).toBe(false)
  })

  it('retains the first verified Xero-derived values for later tax override detection', () => {
    const remote = {
      contactID: '11111111-1111-4111-8111-111111111111',
      currency: 'NZD',
      invoiceID: '22222222-2222-4222-8222-222222222222',
      lineAmountType: 'Exclusive',
      lineItemIDs: ['33333333-3333-4333-8333-333333333333'],
      lineItems: [{ LineAmount: 42.5, TaxAmount: 6.38 }],
      reference: 'PRECISION-0002',
      status: 'DRAFT',
      subtotal: 42.5,
      total: 48.88,
    }
    const hash = remoteDerivedValuesHash(remote)
    expect(hash).toEqual(expect.any(String))
    const attempt = { safeResponseMetadata: { remoteDerivedValuesHash: hash } }

    expect(remoteDerivedValuesMatchAttempt(attempt, remote)).toBe(true)
    expect(
      remoteDerivedValuesMatchAttempt(attempt, {
        ...remote,
        lineItems: [{ LineAmount: 42.5, TaxAmount: 6.37 }],
        total: 48.87,
      }),
    ).toBe(false)
    expect(remoteDerivedValuesMatchAttempt({ safeResponseMetadata: {} }, remote)).toBe(true)
  })
})
