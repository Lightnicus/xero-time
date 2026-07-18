import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAccountEmailAdapter, RESEND_ADAPTER_NAME } from '@/lib/account-email'
import { parseAccountEmailEnvironment, type AccountEmailEnvironment } from '@/lib/env'

import type { Payload } from 'payload'

const resendConfig: AccountEmailEnvironment = {
  apiKey: 're_unit_test_key',
  configured: true,
  deliveryMode: 'resend',
  fromAddress: 'time@example.com',
  fromName: 'Project Time',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('account email configuration', () => {
  it('defaults to manual delivery and does not initialize an adapter', () => {
    const config = parseAccountEmailEnvironment({})

    expect(config).toEqual({ configured: false, deliveryMode: 'manual' })
    expect(createAccountEmailAdapter(config)).toBeUndefined()
  })

  it('keeps the manual safety switch effective even when Resend values are staged', () => {
    expect(
      parseAccountEmailEnvironment({
        ACCOUNT_EMAIL_DELIVERY_MODE: 'manual',
        RESEND_API_KEY: 're_staged',
        RESEND_FROM_ADDRESS: 'time@example.com',
        RESEND_FROM_NAME: 'Project Time',
      }),
    ).toEqual({ configured: false, deliveryMode: 'manual' })
  })

  it('fails closed when Resend configuration is missing or unsafe', () => {
    expect(() => parseAccountEmailEnvironment({ ACCOUNT_EMAIL_DELIVERY_MODE: 'resend' })).toThrow(
      /are required/,
    )
    expect(() =>
      parseAccountEmailEnvironment({
        ACCOUNT_EMAIL_DELIVERY_MODE: 'resend',
        RESEND_API_KEY: 're_invalid key',
        RESEND_FROM_ADDRESS: 'time@example.com',
        RESEND_FROM_NAME: 'Project Time',
      }),
    ).toThrow(/API key/)
    expect(() =>
      parseAccountEmailEnvironment({
        ACCOUNT_EMAIL_DELIVERY_MODE: 'resend',
        RESEND_API_KEY: 're_valid',
        RESEND_FROM_ADDRESS: 'not-an-email',
        RESEND_FROM_NAME: 'Project Time',
      }),
    ).toThrow(/valid email address/)
    expect(() =>
      parseAccountEmailEnvironment({
        ACCOUNT_EMAIL_DELIVERY_MODE: 'resend',
        RESEND_API_KEY: 're_valid',
        RESEND_FROM_ADDRESS: 'time@example.com',
        RESEND_FROM_NAME: 'Project\nTime',
      }),
    ).toThrow(/single-line name/)
  })

  it('initializes the official adapter and maps the configured sender', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ id: 'email-id' }),
      status: 200,
    })
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createAccountEmailAdapter(resendConfig)
    const email = adapter?.({ payload: {} as Payload })

    expect(email?.name).toBe(RESEND_ADAPTER_NAME)
    expect(email?.defaultFromAddress).toBe('time@example.com')
    expect(email?.defaultFromName).toBe('Project Time')

    await email?.sendEmail({
      subject: 'Account setup',
      text: 'Follow the setup link.',
      to: 'invitee@example.com',
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [endpoint, request] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(endpoint).toBe('https://api.resend.com/emails')
    expect(request.headers).toEqual({
      Authorization: 'Bearer re_unit_test_key',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(String(request.body))).toMatchObject({
      from: 'Project Time <time@example.com>',
      subject: 'Account setup',
      text: 'Follow the setup link.',
      to: 'invitee@example.com',
    })
  })
})
