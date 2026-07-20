// @vitest-environment node

import { createLocalReq, getPayload, registerFirstUserOperation, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { validateXeroBillingDefaults } from '@/lib/billing/default-validation'
import type { AppSession } from '@/lib/member-app/session'
import type { XeroAccountingClient } from '@/lib/xero/accounting/client'
import {
  createXeroContact,
  importXeroContact,
  linkXeroContact,
  refreshCustomerContact,
  searchXeroContacts,
} from '@/lib/xero/accounting/contacts'
import { AccountingIntegrationError } from '@/lib/xero/accounting/contracts'
import { refreshXeroReferenceData } from '@/lib/xero/accounting/reference-data'
import type { XeroConnection } from '@/payload-types'
import config from '@/payload.config'

const PASSWORD = 'contact-reference-password-123!'
const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const FIRST_CONTACT_ID = '22222222-2222-4222-8222-222222222222'
const SECOND_CONTACT_ID = '33333333-3333-4333-8333-333333333333'

type ContactRecord = {
  ContactID: string
  ContactNumber?: string
  ContactStatus: 'ACTIVE' | 'ARCHIVED'
  EmailAddress?: string
  Name: string
}

let payload: Payload
let ownerSession: AppSession
let memberSession: AppSession
let connection: XeroConnection
let firstCustomerID: string
let secondCustomerID: string
let nextContactSequence = 10
let ambiguousNextContactCreate = false
let draftInvoiceActionStatus = 'ALLOWED'
let organisationResponseTenantID = TENANT_ID

const contacts = new Map<string, ContactRecord>([
  [
    FIRST_CONTACT_ID,
    {
      ContactID: FIRST_CONTACT_ID,
      ContactNumber: 'C-001',
      ContactStatus: 'ACTIVE',
      EmailAddress: 'first.contact@example.test',
      Name: 'First Xero Contact',
    },
  ],
  [
    SECOND_CONTACT_ID,
    {
      ContactID: SECOND_CONTACT_ID,
      ContactNumber: 'C-002',
      ContactStatus: 'ACTIVE',
      EmailAddress: 'second.contact@example.test',
      Name: 'Second Xero Contact',
    },
  ],
])

const clear = async (): Promise<void> => {
  for (const slug of [
    'payload-jobs',
    'audit-events',
    'xero-contact-operations',
    'xero-attempts',
    'invoice-export-entries',
    'invoice-exports',
    'export-batches',
    'xero-reference-data',
    'xero-oauth-states',
    'xero-connections',
    'time-entries',
    'projects',
    'customers',
    'invitations',
    'external-auth-sessions',
    'auth-identities',
    'users',
  ]) {
    await payload.db.collections[slug]?.deleteMany({})
    await payload.db.versions[slug]?.deleteMany({})
  }
  await payload.db.connection.db?.collection('application_bootstrap_locks').deleteMany({})
}

const contactResponse = (values: ContactRecord[]) => ({ data: { Contacts: values } })

const client: XeroAccountingClient = {
  accountingGet: vi.fn(async (_accessToken, _tenantID, path, parameters = {}) => {
    if (path === 'Organisation') {
      return {
        data: {
          Organisations: [
            {
              BaseCurrency: 'NZD',
              IsDemoCompany: true,
              Name: 'Contact Demo Company',
              OrganisationID: organisationResponseTenantID,
              OrganisationType: 'COMPANY',
            },
          ],
        },
      }
    }
    if (path === 'Organisation/Actions') {
      return {
        data: {
          Actions: [{ Name: 'CreateDraftInvoice', Status: draftInvoiceActionStatus }],
        },
      }
    }
    if (path === 'Accounts') {
      return {
        data: {
          Accounts: [
            {
              AccountID: 'account-sales-200',
              Class: 'REVENUE',
              Code: '200',
              Name: 'Sales',
              Status: 'ACTIVE',
              Type: 'REVENUE',
            },
          ],
        },
      }
    }
    if (path === 'TaxRates') {
      return {
        data: {
          TaxRates: [
            {
              CanApplyToRevenue: true,
              EffectiveRate: 15,
              Name: 'GST on Income',
              Status: 'ACTIVE',
              TaxType: 'OUTPUT2',
            },
          ],
        },
      }
    }
    if (path === 'Currencies') {
      return { data: { Currencies: [{ Code: 'NZD', Description: 'New Zealand Dollar' }] } }
    }
    if (path === 'TrackingCategories') {
      return {
        data: {
          TrackingCategories: [
            {
              Name: 'Region',
              Options: [
                {
                  Name: 'New Zealand',
                  Status: 'ACTIVE',
                  TrackingOptionID: 'tracking-option-nz',
                },
              ],
              Status: 'ACTIVE',
              TrackingCategoryID: 'tracking-region',
            },
          ],
        },
      }
    }
    if (path.startsWith('Contacts/')) {
      const contact = contacts.get(path.slice('Contacts/'.length))
      return contactResponse(contact ? [structuredClone(contact)] : [])
    }
    if (path === 'Contacts') {
      const searchTerm = parameters.searchTerm?.toLowerCase() ?? ''
      return contactResponse(
        [...contacts.values()]
          .filter((contact) =>
            [contact.Name, contact.EmailAddress, contact.ContactNumber]
              .filter(Boolean)
              .some((value) => value?.toLowerCase().includes(searchTerm)),
          )
          .map((contact) => structuredClone(contact)),
      )
    }
    return { data: {} }
  }),
  accountingPost: vi.fn(async (_accessToken, _tenantID, path, body) => {
    if (path !== 'Contacts') return { data: {} }
    const envelope = body as { Contacts?: Array<Record<string, unknown>> }
    const request = envelope.Contacts?.[0] ?? {}
    nextContactSequence += 1
    const contactID = `00000000-0000-4000-8000-${String(nextContactSequence).padStart(12, '0')}`
    const created: ContactRecord = {
      ContactID: contactID,
      ContactNumber: typeof request.ContactNumber === 'string' ? request.ContactNumber : undefined,
      ContactStatus: 'ACTIVE',
      EmailAddress: typeof request.EmailAddress === 'string' ? request.EmailAddress : undefined,
      Name: String(request.Name ?? ''),
    }
    contacts.set(contactID, created)
    if (ambiguousNextContactCreate) {
      ambiguousNextContactCreate = false
      throw new AccountingIntegrationError(
        'contact-response-lost',
        'The response was lost after contact creation.',
        { requestMayHaveBeenSent: true, retryable: true },
      )
    }
    return contactResponse([structuredClone(created)])
  }),
  deleteConnection: vi.fn(async () => undefined),
  exchangeCode: vi.fn(async () => {
    throw new Error('Not used by this suite.')
  }),
  listConnections: vi.fn(async () => []),
  refreshTokens: vi.fn(async () => {
    throw new Error('Not used by this suite.')
  }),
  revokeRefreshToken: vi.fn(async () => undefined),
}

const token = () => ({ accessToken: 'contact-reference-access', connection })
const overrides = () => ({ client, token: token() })

describe.sequential('Xero contacts and reference data', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    await clear()
    const anonymousReq = await createLocalReq({}, payload)
    const bootstrap = await registerFirstUserOperation({
      collection: payload.collections.users,
      data: {
        active: true,
        displayName: 'Contact Owner',
        email: 'contact-owner@example.test',
        password: PASSWORD,
        role: 'owner',
        timezone: 'Pacific/Auckland',
      } as never,
      req: anonymousReq,
    })
    if (!bootstrap.user) throw new Error('Owner bootstrap failed.')
    ownerSession = {
      payload,
      req: await createLocalReq({ user: bootstrap.user }, payload),
      user: bootstrap.user,
    }
    const member = await payload.create({
      collection: 'users',
      data: {
        _verified: true,
        active: true,
        displayName: 'Contact Member',
        email: 'contact-member@example.test',
        password: PASSWORD,
        role: 'member',
        timezone: 'Pacific/Auckland',
      },
      overrideAccess: false,
      req: ownerSession.req,
    })
    memberSession = {
      payload,
      req: await createLocalReq({ user: member }, payload),
      user: member,
    }
    connection = await payload.create({
      collection: 'xero-connections',
      data: {
        connectionId: '44444444-4444-4444-8444-444444444444',
        grantedScopes: [
          'offline_access',
          'accounting.invoices',
          'accounting.contacts',
          'accounting.settings.read',
        ],
        initiatedBy: bootstrap.user.id,
        singletonKey: 'business-accounting',
        status: 'connected',
        tenantId: TENANT_ID,
        tenantName: 'Contact Demo Company',
        tenantType: 'ORGANISATION',
        tokenVersion: 1,
      },
      overrideAccess: true,
      req: ownerSession.req,
      showHiddenFields: true,
    })
    // Payload collection writes may open their own transaction on the request.
    // Do not run two writes concurrently through the same request/session.
    const firstCustomer = await payload.create({
      collection: 'customers',
      data: {
        billingEmail: 'local.first@example.test',
        currency: 'NZD',
        name: 'Local First',
      } as never,
      overrideAccess: false,
      req: ownerSession.req,
    })
    const secondCustomer = await payload.create({
      collection: 'customers',
      data: {
        billingEmail: 'local.second@example.test',
        currency: 'NZD',
        name: 'Local Second',
      } as never,
      overrideAccess: false,
      req: ownerSession.req,
    })
    firstCustomerID = String(firstCustomer.id)
    secondCustomerID = String(secondCustomer.id)
  }, 60_000)

  afterAll(async () => {
    if (!payload) return
    await clear()
    await payload.destroy()
  })

  it('refreshes tenant reference data and validates billing defaults', async () => {
    await expect(refreshXeroReferenceData(ownerSession, overrides())).resolves.toMatchObject({
      capabilityAvailable: true,
      resourceCount: 6,
    })
    const references = await payload.find({
      collection: 'xero-reference-data',
      depth: 0,
      overrideAccess: true,
      pagination: false,
    })
    expect(references.docs).toHaveLength(6)
    expect(references.docs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: '200', resourceType: 'account', status: 'active' }),
        expect.objectContaining({ code: 'OUTPUT2', resourceType: 'tax-rate' }),
        expect.objectContaining({
          code: 'CreateDraftInvoice',
          metadata: { providerStatus: 'ALLOWED' },
          resourceType: 'organisation-action',
          status: 'active',
          type: 'ALLOWED',
        }),
      ]),
    )
    expect(vi.mocked(client.accountingGet).mock.calls.map((call) => call[2])).toEqual(
      expect.arrayContaining(['Organisation', 'Organisation/Actions']),
    )
    await expect(
      validateXeroBillingDefaults(ownerSession.req, {
        accountCode: '200',
        taxType: 'OUTPUT2',
      }),
    ).resolves.toBeUndefined()
    await expect(
      validateXeroBillingDefaults(ownerSession.req, {
        accountCode: '999',
        taxType: 'OUTPUT2',
      }),
    ).rejects.toMatchObject({ code: 'invalid-billing-defaults' })
  })

  it('keeps a denied draft-invoice action without reporting the capability', async () => {
    draftInvoiceActionStatus = 'NOT-ALLOWED'
    try {
      await expect(refreshXeroReferenceData(ownerSession, overrides())).resolves.toMatchObject({
        capabilityAvailable: false,
        resourceCount: 6,
      })
      const references = await payload.find({
        collection: 'xero-reference-data',
        depth: 0,
        overrideAccess: true,
        pagination: false,
      })
      expect(references.docs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'CreateDraftInvoice',
            metadata: { providerStatus: 'NOT-ALLOWED' },
            resourceType: 'organisation-action',
            status: 'unavailable',
            type: 'NOT-ALLOWED',
          }),
        ]),
      )
    } finally {
      draftInvoiceActionStatus = 'ALLOWED'
    }
  })

  it('rejects reference data for another tenant without replacing the existing cache', async () => {
    const before = await payload.find({
      collection: 'xero-reference-data',
      depth: 0,
      overrideAccess: true,
      pagination: false,
      sort: 'id',
    })
    organisationResponseTenantID = '99999999-9999-4999-8999-999999999999'
    try {
      await expect(refreshXeroReferenceData(ownerSession, overrides())).rejects.toMatchObject({
        code: 'wrong-tenant',
      })
      const after = await payload.find({
        collection: 'xero-reference-data',
        depth: 0,
        overrideAccess: true,
        pagination: false,
        sort: 'id',
      })
      expect(after.docs).toEqual(before.docs)
    } finally {
      organisationResponseTenantID = TENANT_ID
    }
  })

  it('links, searches, imports, and prevents duplicate ContactID mappings', async () => {
    await linkXeroContact(
      ownerSession,
      { contactID: FIRST_CONTACT_ID, customerID: firstCustomerID },
      overrides(),
    )
    const search = await searchXeroContacts(ownerSession, { query: 'contact' }, overrides())
    expect(search.contacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contactID: FIRST_CONTACT_ID,
          locallyMappedCustomerID: firstCustomerID,
          status: 'active',
        }),
      ]),
    )
    await expect(
      linkXeroContact(
        ownerSession,
        { contactID: FIRST_CONTACT_ID, customerID: secondCustomerID },
        overrides(),
      ),
    ).rejects.toMatchObject({ code: 'contact-already-mapped' })

    const imported = await importXeroContact(
      ownerSession,
      { contactID: SECOND_CONTACT_ID, currency: 'NZD' },
      overrides(),
    )
    expect(imported).toMatchObject({
      name: 'Second Xero Contact',
      xeroContactId: SECOND_CONTACT_ID,
      xeroMappingStatus: 'active',
    })
  })

  it('reconciles an ambiguous explicit contact create without posting twice', async () => {
    ambiguousNextContactCreate = true
    const postCountBefore = vi.mocked(client.accountingPost).mock.calls.length
    await expect(
      createXeroContact(
        ownerSession,
        { confirmation: true, customerID: secondCustomerID },
        overrides(),
      ),
    ).resolves.toBeUndefined()
    expect(vi.mocked(client.accountingPost).mock.calls.length - postCountBefore).toBe(1)
    const [customer, operations] = await Promise.all([
      payload.findByID({
        collection: 'customers',
        depth: 0,
        id: secondCustomerID,
        overrideAccess: true,
      }),
      payload.find({
        collection: 'xero-contact-operations',
        depth: 0,
        overrideAccess: true,
        where: { customer: { equals: secondCustomerID } },
      }),
    ])
    expect(customer.xeroMappingStatus).toBe('active')
    expect(customer.xeroContactId).toMatch(/^[0-9a-f-]{36}$/)
    expect(operations.docs).toHaveLength(1)
    expect(operations.docs[0]).toMatchObject({ state: 'succeeded' })
  })

  it('refreshes archived status and keeps all Xero contact operations owner/admin-only', async () => {
    const firstContact = contacts.get(FIRST_CONTACT_ID)
    if (!firstContact) throw new Error('The first contact fixture is missing.')
    firstContact.ContactStatus = 'ARCHIVED'
    await refreshCustomerContact(ownerSession, firstCustomerID, overrides())
    await expect(
      payload.findByID({
        collection: 'customers',
        depth: 0,
        id: firstCustomerID,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ xeroMappingStatus: 'archived' })

    await expect(
      searchXeroContacts(memberSession, { query: 'contact' }, overrides()),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(refreshXeroReferenceData(memberSession, overrides())).rejects.toMatchObject({
      code: 'forbidden',
    })
  })
})
