// @vitest-environment node

import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { AccountingIntegrationError } from '@/lib/xero/accounting/contracts'
import { IdentityIntegrationError } from '@/lib/xero/identity/contracts'

import { FakeXeroAccountingServer } from '../fakes/xero-accounting'
import { FakeOIDCProvider } from '../fakes/xero-identity'

const verifier = 'v'.repeat(64)
const pkceChallenge = createHash('sha256').update(verifier).digest('base64url')

describe('controllable fake Xero accounting server', () => {
  it("serves organisation actions using Xero's current action contract", async () => {
    const server = new FakeXeroAccountingServer()
    server.setOrganisationActions([
      { Name: 'CreateDraftInvoice', Status: 'ALLOWED' },
      { Name: 'CreateRepeatingInvoice', Status: 'NOT-ALLOWED' },
    ])

    await expect(
      server.client().accountingGet('fake-access', 'fake-tenant', 'Organisation/Actions'),
    ).resolves.toMatchObject({
      data: {
        Actions: [
          { Name: 'CreateDraftInvoice', Status: 'ALLOWED' },
          { Name: 'CreateRepeatingInvoice', Status: 'NOT-ALLOWED' },
        ],
      },
    })
  })

  it('serves configurable Xero items without inventing archive state', async () => {
    const server = new FakeXeroAccountingServer()
    server.setItems([
      {
        Code: 'CONSULTING',
        IsPurchased: false,
        IsSold: false,
        IsTrackedAsInventory: false,
        ItemID: '00000000-0000-4000-8000-000000000005',
        Name: 'Consulting',
        SalesDetails: null,
      },
    ])

    await expect(
      server.client().accountingGet('fake-access', 'fake-tenant', 'Items'),
    ).resolves.toMatchObject({
      data: {
        Items: [
          {
            Code: 'CONSULTING',
            IsSold: false,
            ItemID: '00000000-0000-4000-8000-000000000005',
          },
        ],
      },
    })
  })

  it('creates and reconciles an invoice after an ambiguous lost response', async () => {
    const server = new FakeXeroAccountingServer()
    const client = server.client()
    const request = {
      Contact: { ContactID: '00000000-0000-4000-8000-000000000010' },
      CurrencyCode: 'NZD',
      LineItems: [{ Description: 'Redacted work', Quantity: 1, UnitAmount: 100 }],
      Reference: 'TIME-REDACTED-1',
      Status: 'DRAFT',
    }
    server.enqueue('post', 'ambiguous-create')

    await expect(
      client.accountingPost('fake-access', 'fake-tenant', 'Invoices', request, 'fake-key'),
    ).rejects.toMatchObject({ requestMayHaveBeenSent: true, retryable: true })

    const reconciliation = await client.accountingGet('fake-access', 'fake-tenant', 'Invoices', {
      where: 'Reference=="TIME-REDACTED-1"',
    })
    expect(reconciliation.data).toMatchObject({
      Invoices: [
        {
          CurrencyCode: 'NZD',
          Reference: 'TIME-REDACTED-1',
          Status: 'DRAFT',
        },
      ],
    })
    const replay = await client.accountingPost(
      'fake-access',
      'fake-tenant',
      'Invoices',
      request,
      'fake-key',
    )
    expect(replay.data).toEqual(reconciliation.data)
    expect(server.invoiceCount()).toBe(1)
  })

  it.each([
    ['validation', 400, false],
    ['unauthorized', 401, false],
    ['rate-limit', 429, true],
    ['server-error', 503, true],
  ] as const)('injects %s responses', async (failure, status, retryable) => {
    const server = new FakeXeroAccountingServer()
    server.enqueue('get', failure)

    await expect(
      server.client().accountingGet('fake-access', 'fake-tenant', 'Invoices'),
    ).rejects.toMatchObject({ status, retryable })
  })

  it('injects delay and connection reset without exposing credential values', async () => {
    const server = new FakeXeroAccountingServer()
    const client = server.client()
    server.enqueue('refresh', { delayMs: 1 })
    await expect(client.refreshTokens('redacted')).resolves.toMatchObject({ expiresIn: 1_800 })
    server.enqueue('post', 'connection-reset')
    await expect(
      client.accountingPost('fake-access', 'fake-tenant', 'Invoices', {}, 'fake-key'),
    ).rejects.toBeInstanceOf(AccountingIntegrationError)
  })
})

describe('controllable fake OIDC provider', () => {
  const start = async (provider: FakeOIDCProvider, state = 'state-1') => {
    const client = provider.client()
    await client.authorizationURL({ nonce: 'nonce-1', pkceChallenge, state })
    return client
  }

  it('publishes discovery/JWKS, signs claims, and rejects code replay', async () => {
    const provider = await FakeOIDCProvider.create()
    const client = await start(provider)
    const code = await provider.issueCode({ pkceVerifier: verifier })
    const callbackURL = new URL(`https://app.example.test/callback?code=${code}&state=state-1`)
    const input = {
      callbackURL,
      expectedNonce: 'nonce-1',
      expectedState: 'state-1',
      pkceVerifier: verifier,
    }

    expect(provider.discovery()).toMatchObject({ issuer: 'https://identity.xero.com' })
    expect(provider.jwks().keys).toHaveLength(1)
    await expect(client.exchangeCallback(input)).resolves.toMatchObject({
      email: 'redacted.member@example.test',
      issuer: 'https://identity.xero.com',
      subject: 'fake-subject-1',
    })
    await expect(client.exchangeCallback(input)).rejects.toMatchObject({ code: 'invalid-code' })
  })

  it('supports retained-key rotation and unknown-key failure', async () => {
    const provider = await FakeOIDCProvider.create()
    const client = await start(provider)
    const retainedCode = await provider.issueCode({ pkceVerifier: verifier })
    await provider.rotateSigningKey()
    expect(provider.jwks().keys).toHaveLength(2)
    await expect(
      client.exchangeCallback({
        callbackURL: new URL(
          `https://app.example.test/callback?code=${retainedCode}&state=state-1`,
        ),
        expectedNonce: 'nonce-1',
        expectedState: 'state-1',
        pkceVerifier: verifier,
      }),
    ).resolves.toBeDefined()

    const retiredProvider = await FakeOIDCProvider.create()
    const retiredClient = await start(retiredProvider)
    const retiredCode = await retiredProvider.issueCode({ pkceVerifier: verifier })
    await retiredProvider.rotateSigningKey()
    retiredProvider.retireAllButActiveKey()
    await expect(
      retiredClient.exchangeCallback({
        callbackURL: new URL(`https://app.example.test/callback?code=${retiredCode}&state=state-1`),
        expectedNonce: 'nonce-1',
        expectedState: 'state-1',
        pkceVerifier: verifier,
      }),
    ).rejects.toMatchObject({ code: 'unknown-signing-key' })
  })

  it('injects malformed claims, forbidden scopes, denial, and outage', async () => {
    const malformed = await FakeOIDCProvider.create()
    const malformedClient = await start(malformed)
    const malformedCode = await malformed.issueCode({
      omitClaims: ['email'],
      pkceVerifier: verifier,
    })
    await expect(
      malformedClient.exchangeCallback({
        callbackURL: new URL(
          `https://app.example.test/callback?code=${malformedCode}&state=state-1`,
        ),
        expectedNonce: 'nonce-1',
        expectedState: 'state-1',
        pkceVerifier: verifier,
      }),
    ).rejects.toMatchObject({ code: 'invalid-claims' })

    const forbidden = await FakeOIDCProvider.create()
    const forbiddenClient = await start(forbidden)
    const forbiddenCode = await forbidden.issueCode({
      pkceVerifier: verifier,
      scope: 'openid profile email offline_access',
    })
    await expect(
      forbiddenClient.exchangeCallback({
        callbackURL: new URL(
          `https://app.example.test/callback?code=${forbiddenCode}&state=state-1`,
        ),
        expectedNonce: 'nonce-1',
        expectedState: 'state-1',
        pkceVerifier: verifier,
      }),
    ).rejects.toBeInstanceOf(IdentityIntegrationError)

    const unavailable = await FakeOIDCProvider.create()
    unavailable.outage = true
    await expect(
      unavailable.client().authorizationURL({ nonce: 'n', pkceChallenge: 'p', state: 's' }),
    ).rejects.toMatchObject({ code: 'provider-unavailable' })
    const denialProvider = await FakeOIDCProvider.create()
    const denialClient = await start(denialProvider)
    await expect(
      denialClient.exchangeCallback({
        callbackURL: new URL('https://app.example.test/callback?error=access_denied'),
        expectedNonce: 'nonce-1',
        expectedState: 'state-1',
        pkceVerifier: verifier,
      }),
    ).rejects.toMatchObject({ code: 'provider-error' })
  })
})
