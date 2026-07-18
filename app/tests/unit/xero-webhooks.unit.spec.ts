// @vitest-environment node

import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { AccountingIntegrationError } from '@/lib/xero/accounting/contracts'
import { classifyExportFailure } from '@/lib/xero/export/processor'
import { parseXeroWebhookEvents, validXeroWebhookSignature } from '@/lib/xero/export/webhooks'

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
