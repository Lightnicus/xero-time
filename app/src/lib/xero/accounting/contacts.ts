import 'server-only'

import { createHash, randomUUID } from 'node:crypto'

import { recordAuditEvent } from '@/lib/audit/service'
import { isRecord, isValidCurrencyCode } from '@/lib/domain/validation'
import type { AppSession } from '@/lib/member-app/session'
import { withPayloadTransaction } from '@/lib/payload/withTransaction'
import type { Customer } from '@/payload-types'

import { AccountingIntegrationError } from './contracts'
import { getValidAccountingAccessToken, resolveAccountingRuntime } from './service'

import type { XeroAccountingClient } from './client'

type AccountingOverrides = {
  client?: XeroAccountingClient
  token?: Awaited<ReturnType<typeof getValidAccountingAccessToken>>
}

export type XeroContactView = {
  contactID: string
  contactNumber?: string
  email?: string
  locallyMappedCustomerID?: string
  name: string
  status: 'active' | 'archived'
}

const stringValue = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max
    ? value.trim()
    : undefined

const contactsFrom = (value: unknown): XeroContactView[] => {
  if (!isRecord(value) || !Array.isArray(value.Contacts)) {
    throw new AccountingIntegrationError(
      'invalid-contact-response',
      'Xero returned invalid contact data.',
    )
  }
  return value.Contacts.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new AccountingIntegrationError(
        'invalid-contact-response',
        'Xero returned invalid contact data.',
      )
    }
    const contactID = stringValue(candidate.ContactID, 100)
    const name = stringValue(candidate.Name, 255)
    if (!contactID || !name) {
      throw new AccountingIntegrationError(
        'invalid-contact-response',
        'Xero returned invalid contact data.',
      )
    }
    return {
      contactID,
      contactNumber: stringValue(candidate.ContactNumber, 100),
      email: stringValue(candidate.EmailAddress, 320),
      name,
      status: candidate.ContactStatus === 'ARCHIVED' ? 'archived' : 'active',
    }
  })
}

const resolveClient = async (
  session: AppSession,
  overrides: AccountingOverrides = {},
): Promise<{ accessToken: string; client: XeroAccountingClient; tenantID: string }> => {
  const runtime = overrides.client ? null : await resolveAccountingRuntime(session)
  const client = overrides.client ?? runtime?.client
  if (!client) throw new AccountingIntegrationError('not-configured', 'Xero is not configured.')
  const token =
    overrides.token ??
    (await getValidAccountingAccessToken(
      session,
      runtime ?? {
        client,
      },
    ))
  if (!token.connection.tenantId) {
    throw new AccountingIntegrationError('missing-tenant', 'The Xero tenant is unavailable.')
  }
  return { accessToken: token.accessToken, client, tenantID: token.connection.tenantId }
}

const mappedCustomers = async (
  session: AppSession,
  contactIDs: string[],
): Promise<Map<string, string>> => {
  if (contactIDs.length === 0) return new Map()
  const customers = await session.payload.find({
    collection: 'customers',
    depth: 0,
    limit: Math.min(100, contactIDs.length),
    overrideAccess: true,
    req: session.req,
    where: { xeroContactId: { in: contactIDs } },
  })
  return new Map(
    customers.docs.flatMap((customer) =>
      customer.xeroContactId ? [[customer.xeroContactId, String(customer.id)] as const] : [],
    ),
  )
}

export async function searchXeroContacts(
  session: AppSession,
  input: { page?: number; query: string },
  overrides: AccountingOverrides = {},
): Promise<{ contacts: XeroContactView[]; page: number }> {
  const query = input.query.trim()
  const page = input.page ?? 1
  if (
    query.length < 2 ||
    query.length > 100 ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 100
  ) {
    throw new AccountingIntegrationError(
      'invalid-contact-search',
      'Enter at least two characters and a valid page.',
    )
  }
  const resolved = await resolveClient(session, overrides)
  const response = await resolved.client.accountingGet(
    resolved.accessToken,
    resolved.tenantID,
    'Contacts',
    { includeArchived: 'true', page: String(page), searchTerm: query },
  )
  const contacts = contactsFrom(response.data)
  const mappings = await mappedCustomers(
    session,
    contacts.map((contact) => contact.contactID),
  )
  return {
    contacts: contacts.map((contact) => ({
      ...contact,
      locallyMappedCustomerID: mappings.get(contact.contactID),
    })),
    page,
  }
}

const fetchContact = async (
  session: AppSession,
  contactID: string,
  overrides: AccountingOverrides = {},
): Promise<XeroContactView> => {
  if (!/^[0-9a-f-]{36}$/i.test(contactID)) {
    throw new AccountingIntegrationError('invalid-contact', 'Select a valid Xero contact.')
  }
  const resolved = await resolveClient(session, overrides)
  const response = await resolved.client.accountingGet(
    resolved.accessToken,
    resolved.tenantID,
    `Contacts/${contactID}`,
  )
  const contacts = contactsFrom(response.data)
  const contact = contacts[0]
  if (!contact || contacts.length !== 1 || contact.contactID !== contactID) {
    throw new AccountingIntegrationError('contact-not-found', 'The Xero contact is unavailable.')
  }
  return contact
}

const assertContactNotMappedElsewhere = async (
  session: AppSession,
  contactID: string,
  customerID?: string,
): Promise<void> => {
  const existing = await session.payload.find({
    collection: 'customers',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req: session.req,
    where: { xeroContactId: { equals: contactID } },
  })
  if (existing.docs[0] && String(existing.docs[0].id) !== String(customerID)) {
    throw new AccountingIntegrationError(
      'contact-already-mapped',
      `That Xero contact is already linked to local customer ${existing.docs[0].id}.`,
    )
  }
}

const mappingData = (session: AppSession, contact: XeroContactView) => ({
  xeroContactEmailSnapshot: contact.email ?? null,
  xeroContactId: contact.contactID,
  xeroContactNameSnapshot: contact.name,
  xeroLastValidatedAt: new Date().toISOString(),
  xeroLinkedAt: new Date().toISOString(),
  xeroLinkedBy: session.user.id,
  xeroMappingStatus: contact.status === 'active' ? ('active' as const) : ('archived' as const),
})

export async function linkXeroContact(
  session: AppSession,
  input: {
    confirmHistoricalChange?: boolean
    contactID: string
    customerID: string
    reason?: string
  },
  overrides: AccountingOverrides = {},
): Promise<void> {
  const contact = await fetchContact(session, input.contactID, overrides)
  await assertContactNotMappedElsewhere(session, contact.contactID, input.customerID)
  const customer = await session.payload.findByID({
    collection: 'customers',
    depth: 0,
    id: input.customerID,
    overrideAccess: true,
    req: session.req,
  })
  const changing = Boolean(customer.xeroContactId && customer.xeroContactId !== contact.contactID)
  if (changing) {
    if (!input.confirmHistoricalChange) {
      throw new AccountingIntegrationError(
        'remap-confirmation-required',
        'Confirm that historical invoices keep their original contact before changing a Xero link.',
      )
    }
    const exports = await session.payload.find({
      collection: 'invoice-exports',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req: session.req,
      where: { customer: { equals: customer.id } },
    })
    if (exports.docs.length > 0 && !input.confirmHistoricalChange) {
      throw new AccountingIntegrationError(
        'historical-exports-exist',
        'Historical exports exist for this customer.',
      )
    }
  }

  await session.payload.update({
    collection: 'customers',
    id: customer.id,
    data: mappingData(session, contact),
    overrideAccess: true,
    req: session.req,
  })
  await recordAuditEvent(
    session.payload,
    {
      actor: session.user.id,
      after: { contactID: contact.contactID, status: contact.status },
      before: { contactID: customer.xeroContactId, status: customer.xeroMappingStatus },
      eventType: 'customer.mapping-changed',
      reason: input.reason,
      targetCollection: 'customers',
      targetId: customer.id,
    },
    session.req,
  )
}

export async function importXeroContact(
  session: AppSession,
  input: { contactID: string; currency: string; localName?: string },
  overrides: AccountingOverrides = {},
): Promise<Customer> {
  if (!isValidCurrencyCode(input.currency)) {
    throw new AccountingIntegrationError('invalid-currency', 'Select a valid customer currency.')
  }
  const contact = await fetchContact(session, input.contactID, overrides)
  await assertContactNotMappedElsewhere(session, contact.contactID)
  const localName = input.localName?.trim() || contact.name
  if (localName.length > 200) {
    throw new AccountingIntegrationError('invalid-customer-name', 'The customer name is too long.')
  }
  const customer = await session.payload.create({
    collection: 'customers',
    data: {
      billingEmail: contact.email,
      currency: input.currency as Customer['currency'],
      name: localName,
      status: 'active',
      ...mappingData(session, contact),
    },
    overrideAccess: true,
    req: session.req,
  })
  await recordAuditEvent(
    session.payload,
    {
      actor: session.user.id,
      after: { contactID: contact.contactID, imported: true },
      eventType: 'customer.mapping-changed',
      targetCollection: 'customers',
      targetId: customer.id,
    },
    session.req,
  )
  return customer
}

export const contactCreationPreview = (
  customer: Customer,
): { EmailAddress?: string; Name: string } => {
  if (!customer.name.trim()) {
    throw new AccountingIntegrationError('invalid-customer', 'The local customer name is required.')
  }
  return {
    EmailAddress: customer.billingEmail ?? undefined,
    Name: customer.name.trim(),
  }
}

const payloadHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value), 'utf8').digest('base64url')

const finalizeCreatedContact = async (
  session: AppSession,
  operationID: string,
  customer: Customer,
  contact: XeroContactView,
): Promise<void> => {
  await assertContactNotMappedElsewhere(session, contact.contactID, String(customer.id))
  await withPayloadTransaction(session.payload, async (req) => {
    await session.payload.update({
      collection: 'customers',
      id: customer.id,
      data: mappingData(session, contact),
      overrideAccess: true,
      req,
    })
    await session.payload.update({
      collection: 'xero-contact-operations',
      id: operationID,
      data: {
        activeCustomerKey: null,
        completedAt: new Date().toISOString(),
        state: 'succeeded',
        xeroContactId: contact.contactID,
      },
      overrideAccess: true,
      req,
    })
    await recordAuditEvent(
      session.payload,
      {
        actor: session.user.id,
        after: { contactID: contact.contactID, createdInXero: true },
        eventType: 'customer.mapping-changed',
        targetCollection: 'customers',
        targetId: customer.id,
      },
      req,
    )
  })
}

/** A creation younger than this may still be waiting for Xero, so it is left alone. */
const CONTACT_CREATION_IN_FLIGHT_MS = 2 * 60 * 1_000

const contactCreationInProgress = () =>
  new AccountingIntegrationError(
    'contact-create-in-progress',
    'A Xero contact is already being created for this customer. Wait a moment, then refresh.',
  )

const isDuplicateKeyError = (error: unknown): boolean => {
  const candidate = error as { cause?: { code?: unknown }; code?: unknown; data?: unknown } | null
  return (
    candidate?.code === 11_000 ||
    candidate?.cause?.code === 11_000 ||
    /duplicate key|E11000|activeCustomerKey/i.test(error instanceof Error ? error.message : '') ||
    JSON.stringify(candidate?.data ?? '').includes('activeCustomerKey')
  )
}

/**
 * Resolves an earlier creation for this customer that never finished (a double submit, a timeout,
 * or an uncertain Xero response) before another one starts. If Xero has the earlier contact it is
 * linked instead of creating a duplicate. Returns true when the customer is now linked.
 */
const settleUnfinishedContactCreation = async (
  session: AppSession,
  customer: Customer,
  resolved: Awaited<ReturnType<typeof resolveClient>>,
): Promise<boolean> => {
  const unfinished = await session.payload.find({
    collection: 'xero-contact-operations',
    depth: 0,
    limit: 10,
    overrideAccess: true,
    pagination: false,
    req: session.req,
    sort: '-createdAt',
    where: {
      and: [
        { customer: { equals: customer.id } },
        { state: { in: ['preparing', 'processing', 'ambiguous'] } },
      ],
    },
  })
  for (const operation of unfinished.docs) {
    const inFlight =
      operation.state !== 'ambiguous' &&
      Date.parse(operation.createdAt) > Date.now() - CONTACT_CREATION_IN_FLIGHT_MS
    if (inFlight) throw contactCreationInProgress()

    const search = await resolved.client.accountingGet(
      resolved.accessToken,
      resolved.tenantID,
      'Contacts',
      { searchTerm: operation.applicationReference },
    )
    const matches = contactsFrom(search.data).filter(
      (contact) => contact.contactNumber === operation.applicationReference,
    )
    const match = matches.length === 1 ? matches[0] : undefined
    if (match) {
      await finalizeCreatedContact(session, String(operation.id), customer, match)
      return true
    }
    await session.payload.update({
      collection: 'xero-contact-operations',
      id: operation.id,
      data: {
        activeCustomerKey: null,
        lastErrorCode: 'not-found-in-xero',
        lastErrorMessage: 'Xero has no contact from this attempt; a new attempt replaced it.',
        state: 'failed',
      },
      overrideAccess: true,
      req: session.req,
    })
  }
  return false
}

export async function createXeroContact(
  session: AppSession,
  input: { confirmation: boolean; customerID: string },
  overrides: AccountingOverrides = {},
): Promise<void> {
  if (!input.confirmation) {
    throw new AccountingIntegrationError('confirmation-required', 'Confirm the contact payload.')
  }
  const customer = await session.payload.findByID({
    collection: 'customers',
    depth: 0,
    id: input.customerID,
    overrideAccess: true,
    req: session.req,
  })
  if (customer.xeroContactId) {
    throw new AccountingIntegrationError('already-mapped', 'That customer is already mapped.')
  }
  const resolved = await resolveClient(session, overrides)
  if (await settleUnfinishedContactCreation(session, customer, resolved)) return

  const reference = `CONTACT-${randomUUID()}`
  const request = { ...contactCreationPreview(customer), ContactNumber: reference }
  let operation: { id: string }
  try {
    operation = await session.payload.create({
      collection: 'xero-contact-operations',
      data: {
        activeCustomerKey: String(customer.id),
        applicationReference: reference,
        attemptCount: 0,
        customer: customer.id,
        idempotencyKey: reference,
        payloadHash: payloadHash(request),
        requestPayload: request,
        requestedBy: session.user.id,
        state: 'preparing',
      },
      overrideAccess: true,
      req: session.req,
    })
  } catch (error) {
    if (isDuplicateKeyError(error)) throw contactCreationInProgress()
    throw error
  }
  await session.payload.update({
    collection: 'xero-contact-operations',
    id: operation.id,
    data: { attemptCount: 1, state: 'processing' },
    overrideAccess: true,
    req: session.req,
  })

  try {
    const response = await resolved.client.accountingPost(
      resolved.accessToken,
      resolved.tenantID,
      'Contacts',
      { Contacts: [request] },
      reference,
    )
    const contacts = contactsFrom(response.data)
    if (contacts.length !== 1) {
      throw new AccountingIntegrationError(
        'invalid-contact-response',
        'Xero did not return the created contact.',
      )
    }
    const contact = contacts[0]
    if (!contact) {
      throw new AccountingIntegrationError(
        'invalid-contact-response',
        'Xero did not return the created contact.',
      )
    }
    await finalizeCreatedContact(session, operation.id, customer, contact)
  } catch (error) {
    const integrationError =
      error instanceof AccountingIntegrationError
        ? error
        : new AccountingIntegrationError(
            'contact-create-failed',
            'The Xero contact was not created.',
          )
    if (integrationError.requestMayHaveBeenSent) {
      try {
        const reconciliation = await resolved.client.accountingGet(
          resolved.accessToken,
          resolved.tenantID,
          'Contacts',
          { searchTerm: reference },
        )
        const matches = contactsFrom(reconciliation.data).filter(
          (contact) => contact.contactNumber === reference,
        )
        if (matches.length === 1) {
          const match = matches[0]
          if (!match) throw new Error('The reconciled contact was unavailable.')
          await finalizeCreatedContact(session, operation.id, customer, match)
          return
        }
      } catch {
        // Preserve ambiguous state; an operator can reconcile it without issuing another create.
      }
    }
    await session.payload.update({
      collection: 'xero-contact-operations',
      id: operation.id,
      data: {
        // An uncertain result stays the customer's unfinished creation, so the next attempt
        // looks for it in Xero before creating anything.
        activeCustomerKey: integrationError.requestMayHaveBeenSent ? String(customer.id) : null,
        lastErrorCode: integrationError.code,
        lastErrorMessage: integrationError.requestMayHaveBeenSent
          ? 'The contact result is uncertain; the next attempt checks Xero for it first.'
          : 'Xero rejected the contact request.',
        state: integrationError.requestMayHaveBeenSent ? 'ambiguous' : 'failed',
      },
      overrideAccess: true,
      req: session.req,
    })
    throw integrationError
  }
}

export async function refreshCustomerContact(
  session: AppSession,
  customerID: string,
  overrides: AccountingOverrides = {},
): Promise<void> {
  const customer = await session.payload.findByID({
    collection: 'customers',
    depth: 0,
    id: customerID,
    overrideAccess: true,
    req: session.req,
  })
  if (!customer.xeroContactId) {
    throw new AccountingIntegrationError('unmapped-customer', 'That customer is not mapped.')
  }
  try {
    const contact = await fetchContact(session, customer.xeroContactId, overrides)
    await session.payload.update({
      collection: 'customers',
      id: customer.id,
      data: {
        ...mappingData(session, contact),
        xeroLinkedAt: customer.xeroLinkedAt,
        xeroLinkedBy: customer.xeroLinkedBy,
      },
      overrideAccess: true,
      req: session.req,
    })
  } catch (error) {
    // Only Xero saying the contact is gone invalidates the mapping. A timeout, rate limit or
    // broken connection says nothing about the contact and must not block billing for it.
    const contactMissing =
      error instanceof AccountingIntegrationError &&
      (error.code === 'contact-not-found' || error.status === 404)
    if (contactMissing) {
      await session.payload.update({
        collection: 'customers',
        id: customer.id,
        data: {
          xeroLastValidatedAt: new Date().toISOString(),
          xeroMappingStatus: 'invalid',
        },
        overrideAccess: true,
        req: session.req,
      })
    }
    throw error
  }
}
