import { describe, expect, it } from 'vitest'

import { connectionFailureMessage, connectionRecoveryCause } from '@/lib/xero/accounting/recovery'
import { consecutiveRetryWaits } from '@/lib/xero/export/processor'

describe('Xero connection recovery guidance', () => {
  it.each([
    ['token-refresh-invalid-client', 'action-required', 'client-credentials'],
    ['token-refresh-unauthorized-client', 'action-required', 'client-credentials'],
    ['token-refresh-invalid-grant', 'action-required', 'authorization-expired'],
    ['token-refresh-http-400', 'action-required', 'authorization-expired'],
    ['connection-missing', 'action-required', 'organisation-removed'],
    ['refresh-identity-mismatch', 'action-required', 'authorizer-mismatch'],
    ['remote-disconnect-incomplete', 'disconnected', 'disconnected'],
    [null, 'disconnected', 'disconnected'],
    [null, 'action-required', 'unknown'],
  ] as const)('maps %s (%s) to %s', (code, status, cause) => {
    expect(connectionRecoveryCause(code, status)).toBe(cause)
  })

  it('tells the owner to update credentials only when Xero rejected the client', () => {
    expect(connectionFailureMessage('token-refresh-invalid-client')).toContain(
      'Update the OAuth application credentials',
    )
    expect(connectionFailureMessage('token-refresh-invalid-grant')).not.toContain('credentials')
    expect(connectionFailureMessage('token-refresh-invalid-grant')).toContain('Reconnect Xero')
  })
})

describe('export retry backoff', () => {
  it('counts only the trailing run of retry waits', () => {
    const entry = (to: string) => ({ at: '2026-11-13T00:00:00.000Z', from: 'processing', to })
    expect(consecutiveRetryWaits({ stateHistory: null })).toBe(0)
    expect(
      consecutiveRetryWaits({
        stateHistory: [entry('queued'), entry('retry-wait'), entry('retry-wait')],
      }),
    ).toBe(2)
    expect(
      consecutiveRetryWaits({
        stateHistory: [entry('retry-wait'), entry('reconciling'), entry('retry-wait')],
      }),
    ).toBe(1)
  })
})
