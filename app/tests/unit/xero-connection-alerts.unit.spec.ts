import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  canDeliverAccountEmail: vi.fn(() => true),
  checkAccountingConnectionHealth: vi.fn(async () => ({ status: 'connected' })),
  createAccountingSystemSession: vi.fn(async () => ({ session: true })),
  findOneAndUpdate: vi.fn(),
}))

vi.mock('@/lib/account-email', () => ({ canDeliverAccountEmail: mocks.canDeliverAccountEmail }))
vi.mock('@/lib/payload/mongo', () => ({
  requireMongoModel: () => ({ findOneAndUpdate: mocks.findOneAndUpdate }),
}))
vi.mock('@/lib/xero/accounting/service', () => ({
  checkAccountingConnectionHealth: mocks.checkAccountingConnectionHealth,
  createAccountingSystemSession: mocks.createAccountingSystemSession,
}))

import { reconnectAlertEmail, sendReconnectAlert } from '@/lib/xero/accounting/reconnect-alert'
import { checkConnectionWhilePaused } from '@/lib/xero/export/maintenance'

import type { Payload, PayloadRequest } from 'payload'

const alertPayload = () => {
  const sendEmail = vi.fn(async () => undefined)
  const payload = {
    find: vi.fn(async () => ({ docs: [{ email: 'me@example.test' }] })),
    logger: { info: vi.fn(), warn: vi.fn() },
    sendEmail,
  } as unknown as Payload
  return { payload, sendEmail }
}

describe('Xero reconnect email', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.canDeliverAccountEmail.mockReturnValue(true)
  })

  it('names the organisation, explains the cause and links to the reconnect steps', () => {
    const email = reconnectAlertEmail({
      errorCode: 'token-refresh-invalid-grant',
      settingsURL: 'https://time.example.test/app/settings/xero#reconnect',
      tenantName: 'Demo <Company>',
    })
    expect(email.subject).toBe('Xero (Demo <Company>) needs to be reconnected')
    expect(email.html).toContain('Xero (Demo &lt;Company&gt;)')
    expect(email.html).toContain('Reconnect Xero to resume invoice exports.')
    expect(email.html).toContain('href="https://time.example.test/app/settings/xero#reconnect"')
  })

  it('sends once per outage and only when email delivery is set up', async () => {
    const { payload, sendEmail } = alertPayload()
    mocks.findOneAndUpdate.mockResolvedValueOnce({
      lastErrorCode: 'token-refresh-invalid-grant',
      tenantName: 'Demo Company',
    })
    await expect(sendReconnectAlert(payload, 'connection-1')).resolves.toBe(true)
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Xero (Demo Company) needs to be reconnected',
        to: ['me@example.test'],
      }),
    )
    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ reconnectAlertSentAt: null, status: 'action-required' }),
      expect.anything(),
      expect.anything(),
    )

    // Already sent for this outage: the claim finds nothing.
    mocks.findOneAndUpdate.mockResolvedValueOnce(null)
    await expect(sendReconnectAlert(payload, 'connection-1')).resolves.toBe(false)

    mocks.canDeliverAccountEmail.mockReturnValue(false)
    await expect(sendReconnectAlert(payload, 'connection-1')).resolves.toBe(false)
    expect(sendEmail).toHaveBeenCalledOnce()
  })

  it('never lets a delivery failure reach the caller', async () => {
    const { payload, sendEmail } = alertPayload()
    sendEmail.mockRejectedValueOnce(new Error('Resend is down'))
    mocks.findOneAndUpdate.mockResolvedValueOnce({ lastErrorCode: 'connection-missing' })
    await expect(sendReconnectAlert(payload, 'connection-1')).resolves.toBe(false)
  })
})

describe('Xero health checks while processing is paused', () => {
  const connectionPayload = (lastHealthCheckAt: null | string, status = 'connected') =>
    ({
      find: vi.fn(async () => ({ docs: [{ lastHealthCheckAt, status }] })),
    }) as unknown as Payload
  const req = {} as PayloadRequest

  beforeEach(() => vi.clearAllMocks())

  it('checks the connection directly once the daily check is due', async () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString()
    await expect(checkConnectionWhilePaused(connectionPayload(stale), req)).resolves.toBe(1)
    expect(mocks.checkAccountingConnectionHealth).toHaveBeenCalledOnce()
  })

  it('skips a recent check or a connection that is not working', async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1_000).toISOString()
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString()
    await expect(checkConnectionWhilePaused(connectionPayload(recent), req)).resolves.toBe(0)
    await expect(
      checkConnectionWhilePaused(connectionPayload(stale, 'action-required'), req),
    ).resolves.toBe(0)
    expect(mocks.checkAccountingConnectionHealth).not.toHaveBeenCalled()
  })

  it('keeps the cron run going when the check fails', async () => {
    mocks.checkAccountingConnectionHealth.mockRejectedValueOnce(new Error('Xero is down'))
    await expect(checkConnectionWhilePaused(connectionPayload(null), req)).resolves.toBe(1)
  })
})
