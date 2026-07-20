import { setTimeout as delay } from 'node:timers/promises'

import type { XeroAccountingClient, XeroAPIResponse } from '@/lib/xero/accounting/client'
import {
  AccountingIntegrationError,
  REQUIRED_ACCOUNTING_SCOPES,
  type XeroConnectionCandidate,
  type XeroTokenSet,
} from '@/lib/xero/accounting/contracts'

export type FakeAccountingFailure =
  | 'ambiguous-create'
  | 'connection-reset'
  | 'rate-limit'
  | 'server-error'
  | 'unauthorized'
  | 'validation'
  | { delayMs: number }

type Operation = 'delete' | 'exchange' | 'get' | 'list' | 'post' | 'refresh' | 'revoke'

type OrganisationAction = {
  Name: string
  Status: string
}

type StoredInvoice = Record<string, unknown> & {
  Contact: { ContactID: string }
  CurrencyCode: string
  InvoiceID: string
  LineItems: Record<string, unknown>[]
  Reference: string
  Status: string
}

const uuid = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/**
 * Stateful, network-free Xero accounting double. It deliberately lives apart
 * from the identity fake so tests cannot accidentally cross OAuth boundaries.
 */
export class FakeXeroAccountingServer {
  readonly requests: Array<{ operation: Operation; path?: string }> = []

  private connections: XeroConnectionCandidate[] = [
    {
      authEventId: uuid(1),
      connectionId: uuid(2),
      tenantId: uuid(3),
      tenantName: 'Redacted Demo Company',
      tenantType: 'ORGANISATION',
    },
  ]

  private failures = new Map<Operation, FakeAccountingFailure[]>()
  private invoiceSequence = 100
  private invoices = new Map<string, StoredInvoice>()
  private invoicesByIdempotencyKey = new Map<string, StoredInvoice>()
  private organisationActions: OrganisationAction[] = [
    { Name: 'CreateDraftInvoice', Status: 'ALLOWED' },
  ]
  private tokenSequence = 0

  enqueue(operation: Operation, failure: FakeAccountingFailure): void {
    this.failures.set(operation, [...(this.failures.get(operation) ?? []), failure])
  }

  invoice(invoiceID: string): StoredInvoice | undefined {
    return this.invoices.get(invoiceID)
  }

  invoiceCount(): number {
    return this.invoices.size
  }

  setInvoice(invoice: StoredInvoice): void {
    this.invoices.set(invoice.InvoiceID, structuredClone(invoice))
  }

  setOrganisationActions(actions: OrganisationAction[]): void {
    this.organisationActions = structuredClone(actions)
  }

  private async applyFailure(
    operation: Operation,
    requestMayHaveBeenSent: boolean,
  ): Promise<FakeAccountingFailure | null> {
    this.requests.push({ operation })
    const queue = this.failures.get(operation) ?? []
    const failure = queue.shift()
    this.failures.set(operation, queue)
    if (!failure) return null
    if (typeof failure === 'object') {
      await delay(failure.delayMs)
      return null
    }
    if (failure === 'ambiguous-create') return failure
    if (failure === 'connection-reset') {
      throw new AccountingIntegrationError(
        `${operation}-network-error`,
        'The fake accounting connection was reset.',
        { requestMayHaveBeenSent, retryable: true },
      )
    }
    const details = {
      'rate-limit': { retryAfterSeconds: 30, retryable: true, status: 429 },
      'server-error': { retryable: true, status: 503 },
      unauthorized: { retryable: false, status: 401 },
      validation: { retryable: false, status: 400 },
    }[failure]
    throw new AccountingIntegrationError(
      `${operation}-${failure}`,
      'The fake accounting request failed.',
      { ...details, requestMayHaveBeenSent: requestMayHaveBeenSent && details.status >= 500 },
    )
  }

  private tokens(): XeroTokenSet {
    this.tokenSequence += 1
    return {
      accessToken: `fake-accounting-access-${this.tokenSequence}`,
      expiresIn: 1_800,
      refreshToken: `fake-accounting-refresh-${this.tokenSequence}`,
      scopes: [...REQUIRED_ACCOUNTING_SCOPES],
    }
  }

  private createInvoice(body: unknown): StoredInvoice {
    const envelope = asRecord(body)
    const first = Array.isArray(envelope.Invoices) ? envelope.Invoices[0] : envelope
    const request = asRecord(first)
    const contact = asRecord(request.Contact)
    const invoiceID = uuid(++this.invoiceSequence)
    const lines = Array.isArray(request.LineItems)
      ? request.LineItems.map((line, index) => ({
          ...asRecord(line),
          LineItemID: uuid(this.invoiceSequence * 100 + index + 1),
        }))
      : []
    const invoice: StoredInvoice = {
      ...request,
      Contact: { ContactID: String(contact.ContactID ?? '') },
      CurrencyCode: String(request.CurrencyCode ?? ''),
      InvoiceID: invoiceID,
      InvoiceNumber: `INV-FAKE-${this.invoiceSequence}`,
      LineItems: lines,
      Reference: String(request.Reference ?? ''),
      Status: String(request.Status ?? 'DRAFT'),
    }
    this.invoices.set(invoiceID, invoice)
    return structuredClone(invoice)
  }

  client(): XeroAccountingClient {
    return {
      accountingGet: async (_accessToken, _tenantID, path, parameters = {}) => {
        await this.applyFailure('get', false)
        this.requests[this.requests.length - 1] = { operation: 'get', path }
        if (path === 'Organisation/Actions') {
          return {
            correlationID: uuid(900),
            data: { Actions: structuredClone(this.organisationActions) },
            rateLimitRemaining: 59,
          } satisfies XeroAPIResponse
        }
        const invoiceID = path.startsWith('Invoices/') ? path.slice('Invoices/'.length) : null
        let invoices = invoiceID
          ? [this.invoices.get(invoiceID)].filter(Boolean)
          : [...this.invoices.values()]
        const reference = parameters.where?.match(/Reference=="((?:\\.|[^"])*)"/)?.[1]
        if (reference) invoices = invoices.filter((invoice) => invoice?.Reference === reference)
        return {
          correlationID: uuid(900),
          data: { Invoices: structuredClone(invoices) },
          rateLimitRemaining: 59,
        } satisfies XeroAPIResponse
      },
      accountingPost: async (_accessToken, _tenantID, path, body, idempotencyKey) => {
        const failure = await this.applyFailure('post', true)
        this.requests[this.requests.length - 1] = { operation: 'post', path }
        const invoice =
          this.invoicesByIdempotencyKey.get(idempotencyKey) ?? this.createInvoice(body)
        this.invoicesByIdempotencyKey.set(idempotencyKey, invoice)
        if (failure === 'ambiguous-create') {
          throw new AccountingIntegrationError(
            'accounting-post-response-lost',
            'The fake server created the invoice but lost the response.',
            { requestMayHaveBeenSent: true, retryable: true },
          )
        }
        return {
          correlationID: uuid(901),
          data: { Invoices: [invoice] },
          rateLimitRemaining: 58,
        } satisfies XeroAPIResponse
      },
      deleteConnection: async (_accessToken, connectionID) => {
        await this.applyFailure('delete', true)
        this.connections = this.connections.filter(
          (connection) => connection.connectionId !== connectionID,
        )
      },
      exchangeCode: async () => {
        await this.applyFailure('exchange', true)
        return this.tokens()
      },
      listConnections: async (_accessToken, authenticationEventID) => {
        await this.applyFailure('list', false)
        return structuredClone(
          authenticationEventID
            ? this.connections.filter(
                (connection) => connection.authEventId === authenticationEventID,
              )
            : this.connections,
        )
      },
      refreshTokens: async () => {
        await this.applyFailure('refresh', true)
        return this.tokens()
      },
      revokeRefreshToken: async () => {
        await this.applyFailure('revoke', true)
      },
    }
  }
}
