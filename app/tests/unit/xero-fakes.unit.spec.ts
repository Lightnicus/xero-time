// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { AccountingIntegrationError } from '@/lib/xero/accounting/contracts'

import { FakeXeroAccountingServer } from '../fakes/xero-accounting'

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

  it("marks a draft invoice deleted using Xero's wrapped update payload", async () => {
    const server = new FakeXeroAccountingServer()
    const client = server.client()
    const create = await client.accountingPost(
      'fake-access',
      'fake-tenant',
      'Invoices',
      {
        Invoices: [
          {
            Contact: { ContactID: '00000000-0000-4000-8000-000000000010' },
            CurrencyCode: 'NZD',
            LineItems: [{ Description: 'Redacted work', Quantity: 1, UnitAmount: 100 }],
            Reference: 'TIME-DELETE-1',
            Status: 'DRAFT',
          },
        ],
      },
      'fake-create-key',
    )
    const invoice = (create.data as { Invoices: Array<{ InvoiceID: string }> }).Invoices[0]
    if (!invoice) throw new Error('The fake invoice was not created.')
    const body = { Invoices: [{ InvoiceID: invoice.InvoiceID, Status: 'DELETED' }] }

    await expect(
      client.accountingPost(
        'fake-access',
        'fake-tenant',
        `Invoices/${invoice.InvoiceID}`,
        body,
        'fake-delete-key',
      ),
    ).resolves.toMatchObject({
      data: { Invoices: [{ InvoiceID: invoice.InvoiceID, Status: 'DELETED' }] },
    })
    await expect(
      client.accountingPost(
        'fake-access',
        'fake-tenant',
        `Invoices/${invoice.InvoiceID}`,
        body,
        'fake-delete-key',
      ),
    ).resolves.toMatchObject({
      data: { Invoices: [{ InvoiceID: invoice.InvoiceID, Status: 'DELETED' }] },
    })
    expect(server.invoiceCount()).toBe(1)
  })

  it('applies a draft deletion before simulating a lost POST response', async () => {
    const server = new FakeXeroAccountingServer()
    const client = server.client()
    const create = await client.accountingPost(
      'fake-access',
      'fake-tenant',
      'Invoices',
      {
        Invoices: [
          {
            Contact: { ContactID: '00000000-0000-4000-8000-000000000010' },
            CurrencyCode: 'NZD',
            LineItems: [],
            Reference: 'TIME-DELETE-LOST',
            Status: 'DRAFT',
          },
        ],
      },
      'fake-create-lost-key',
    )
    const invoice = (create.data as { Invoices: Array<{ InvoiceID: string }> }).Invoices[0]
    if (!invoice) throw new Error('The fake invoice was not created.')
    server.enqueue('post', 'ambiguous-create')

    await expect(
      client.accountingPost(
        'fake-access',
        'fake-tenant',
        `Invoices/${invoice.InvoiceID}`,
        { Invoices: [{ InvoiceID: invoice.InvoiceID, Status: 'DELETED' }] },
        'fake-delete-lost-key',
      ),
    ).rejects.toMatchObject({ requestMayHaveBeenSent: true, retryable: true })
    await expect(
      client.accountingGet('fake-access', 'fake-tenant', `Invoices/${invoice.InvoiceID}`),
    ).resolves.toMatchObject({
      data: { Invoices: [{ InvoiceID: invoice.InvoiceID, Status: 'DELETED' }] },
    })
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
