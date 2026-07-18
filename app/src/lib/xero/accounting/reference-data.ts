import 'server-only'

import { hasActiveRole } from '@/access/roles'
import { recordAuditEvent } from '@/lib/audit/service'
import { isRecord } from '@/lib/domain/validation'
import type { AppSession } from '@/lib/member-app/session'
import { requireMongoModel } from '@/lib/payload/mongo'
import { withPayloadTransaction } from '@/lib/payload/withTransaction'

import { AccountingIntegrationError } from './contracts'
import { getValidAccountingAccessToken, resolveAccountingRuntime } from './service'

import type { XeroAccountingClient } from './client'
import type { PayloadRequest } from 'payload'

type ReferenceResource = {
  code?: string
  metadata?: Record<string, unknown>
  name: string
  resourceType:
    | 'account'
    | 'currency'
    | 'organisation'
    | 'organisation-action'
    | 'tax-rate'
    | 'tracking-category'
  status: 'active' | 'archived' | 'unavailable'
  type?: string
  xeroId: string
}

const arrayFrom = (value: unknown, key: string): unknown[] => {
  if (!isRecord(value) || !Array.isArray(value[key])) {
    throw new AccountingIntegrationError(
      'invalid-reference-response',
      'Xero returned invalid accounting reference data.',
    )
  }
  return value[key]
}

const requiredString = (value: unknown, max = 255): string => {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new AccountingIntegrationError(
      'invalid-reference-response',
      'Xero returned invalid accounting reference data.',
    )
  }
  return value.trim()
}

const optionalString = (value: unknown, max = 255): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max
    ? value.trim()
    : undefined

const parseAccounts = (value: unknown): ReferenceResource[] =>
  arrayFrom(value, 'Accounts').flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const accountID = requiredString(candidate.AccountID, 100)
    const name = requiredString(candidate.Name)
    const code = optionalString(candidate.Code, 100)
    const type = optionalString(candidate.Type, 100)
    const status = candidate.Status === 'ACTIVE' ? 'active' : 'archived'
    return [
      {
        code,
        metadata: {
          class: optionalString(candidate.Class, 100),
          enablePaymentsToAccount: candidate.EnablePaymentsToAccount === true,
          showInExpenseClaims: candidate.ShowInExpenseClaims === true,
        },
        name,
        resourceType: 'account',
        status,
        type,
        xeroId: accountID,
      },
    ]
  })

const parseTaxRates = (value: unknown): ReferenceResource[] =>
  arrayFrom(value, 'TaxRates').flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const taxType = requiredString(candidate.TaxType, 100)
    return [
      {
        code: taxType,
        metadata: {
          canApplyToAssets: candidate.CanApplyToAssets === true,
          canApplyToRevenue: candidate.CanApplyToRevenue === true,
          displayTaxRate:
            typeof candidate.DisplayTaxRate === 'number' ? candidate.DisplayTaxRate : undefined,
          effectiveRate:
            typeof candidate.EffectiveRate === 'number' ? candidate.EffectiveRate : undefined,
        },
        name: requiredString(candidate.Name),
        resourceType: 'tax-rate',
        status: candidate.Status === 'ACTIVE' ? 'active' : 'archived',
        type: optionalString(candidate.ReportTaxType, 100),
        xeroId: taxType,
      },
    ]
  })

const parseCurrencies = (value: unknown): ReferenceResource[] =>
  arrayFrom(value, 'Currencies').flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const code = requiredString(candidate.Code, 3).toUpperCase()
    return [
      {
        code,
        name: optionalString(candidate.Description) ?? code,
        resourceType: 'currency',
        status: 'active',
        xeroId: code,
      },
    ]
  })

const parseTrackingCategories = (value: unknown): ReferenceResource[] =>
  arrayFrom(value, 'TrackingCategories').flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const categoryID = requiredString(candidate.TrackingCategoryID, 100)
    const name = requiredString(candidate.Name)
    const options = Array.isArray(candidate.Options)
      ? candidate.Options.flatMap((option) =>
          isRecord(option) &&
          typeof option.Name === 'string' &&
          typeof option.TrackingOptionID === 'string'
            ? [
                {
                  id: option.TrackingOptionID.slice(0, 100),
                  name: option.Name.slice(0, 255),
                  status: option.Status === 'ARCHIVED' ? 'archived' : 'active',
                },
              ]
            : [],
        )
      : []
    return [
      {
        code: name,
        metadata: { options },
        name,
        resourceType: 'tracking-category',
        status: candidate.Status === 'ARCHIVED' ? 'archived' : 'active',
        xeroId: categoryID,
      },
    ]
  })

const parseOrganisation = (value: unknown): ReferenceResource[] => {
  const organisation = arrayFrom(value, 'Organisations')[0]
  if (!isRecord(organisation)) {
    throw new AccountingIntegrationError(
      'invalid-reference-response',
      'Xero returned invalid organisation data.',
    )
  }
  const organisationID = requiredString(organisation.OrganisationID, 100)
  const actions = Array.isArray(organisation.OrganisationActions)
    ? organisation.OrganisationActions.filter(
        (action): action is string => typeof action === 'string' && action.length <= 100,
      )
    : []
  return [
    {
      code: optionalString(organisation.ShortCode, 100),
      metadata: {
        baseCurrency: optionalString(organisation.BaseCurrency, 3),
        countryCode: optionalString(organisation.CountryCode, 10),
        isDemoCompany: organisation.IsDemoCompany === true,
        organisationType: optionalString(organisation.OrganisationType, 100),
        version: optionalString(organisation.Version, 100),
      },
      name: requiredString(organisation.Name),
      resourceType: 'organisation',
      status: 'active',
      type: optionalString(organisation.OrganisationType, 100),
      xeroId: organisationID,
    },
    ...actions.map((action): ReferenceResource => ({
      code: action,
      name: action,
      resourceType: 'organisation-action',
      status: 'active',
      xeroId: action,
    })),
  ]
}

const persistReferences = async (
  session: AppSession,
  tenantID: string,
  resources: ReferenceResource[],
  machineActor?: string,
): Promise<void> => {
  await withPayloadTransaction(session.payload, async (req) => {
    const transactionID = await req.transactionID
    const mongoSession = transactionID ? session.payload.db.sessions[transactionID] : undefined
    await requireMongoModel(session.payload, 'xero-reference-data').deleteMany(
      { sourceTenantId: tenantID },
      { session: mongoSession },
    )
    const fetchedAt = new Date().toISOString()
    for (const resource of resources) {
      await session.payload.create({
        collection: 'xero-reference-data',
        data: { ...resource, fetchedAt, sourceTenantId: tenantID },
        overrideAccess: true,
        req,
      })
    }
    const connections = await session.payload.find({
      collection: 'xero-connections',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { singletonKey: { equals: 'business-accounting' } },
    })
    if (connections.docs[0]) {
      await session.payload.update({
        collection: 'xero-connections',
        id: connections.docs[0].id,
        data: {
          lastReferenceDataSyncAt: fetchedAt,
          lastSuccessfulRequestAt: fetchedAt,
        },
        overrideAccess: true,
        req,
      })
    }
    await recordAuditEvent(
      session.payload,
      {
        actor: machineActor ? undefined : session.user.id,
        eventType: 'xero.reference-data-refreshed',
        machineActor,
        metadata: { resourceCount: resources.length },
        targetCollection: 'xero-connections',
        targetId: connections.docs[0]?.id,
      },
      req,
    )
  })
}

export async function refreshXeroReferenceData(
  session: AppSession,
  overrides: {
    client?: XeroAccountingClient
    machineActor?: string
    token?: Awaited<ReturnType<typeof getValidAccountingAccessToken>>
  } = {},
): Promise<{ capabilityAvailable: boolean; resourceCount: number }> {
  if (!hasActiveRole(session.user, ['owner', 'admin'])) {
    throw new AccountingIntegrationError(
      'forbidden',
      'Only an owner or administrator can refresh Xero reference data.',
    )
  }
  const runtime = overrides.client ? null : await resolveAccountingRuntime(session)
  const client = overrides.client ?? runtime?.client
  if (!client) {
    throw new AccountingIntegrationError('not-configured', 'Xero accounting is not configured.')
  }
  const token =
    overrides.token ??
    (await getValidAccountingAccessToken(
      session,
      runtime ?? {
        client,
      },
    ))
  const tenantID = token.connection.tenantId
  if (!tenantID) {
    throw new AccountingIntegrationError('missing-tenant', 'The Xero tenant is unavailable.')
  }
  return refreshWithClient(session, token.accessToken, tenantID, client, overrides.machineActor)
}

const refreshWithClient = async (
  session: AppSession,
  accessToken: string,
  tenantID: string,
  client: XeroAccountingClient,
  machineActor?: string,
): Promise<{ capabilityAvailable: boolean; resourceCount: number }> => {
  const [organisation, accounts, taxRates, currencies, trackingCategories] = await Promise.all([
    client.accountingGet(accessToken, tenantID, 'Organisation'),
    client.accountingGet(accessToken, tenantID, 'Accounts'),
    client.accountingGet(accessToken, tenantID, 'TaxRates'),
    client.accountingGet(accessToken, tenantID, 'Currencies'),
    client.accountingGet(accessToken, tenantID, 'TrackingCategories'),
  ])
  const resources = [
    ...parseOrganisation(organisation.data),
    ...parseAccounts(accounts.data),
    ...parseTaxRates(taxRates.data),
    ...parseCurrencies(currencies.data),
    ...parseTrackingCategories(trackingCategories.data),
  ]
  await persistReferences(session, tenantID, resources, machineActor)
  return {
    capabilityAvailable: resources.some(
      (item) => item.resourceType === 'organisation-action' && item.code === 'CreateDraftInvoice',
    ),
    resourceCount: resources.length,
  }
}

export async function validateXeroBillingDefaults(
  req: PayloadRequest,
  accountCode: string,
  taxType: string,
): Promise<void> {
  const connection = await req.payload.find({
    collection: 'xero-connections',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [
        { singletonKey: { equals: 'business-accounting' } },
        { status: { equals: 'connected' } },
      ],
    },
  })
  const tenantID = connection.docs[0]?.tenantId
  if (!tenantID) return
  const [account, tax] = await Promise.all([
    req.payload.find({
      collection: 'xero-reference-data',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: {
        and: [
          { sourceTenantId: { equals: tenantID } },
          { resourceType: { equals: 'account' } },
          { code: { equals: accountCode } },
          { status: { equals: 'active' } },
        ],
      },
    }),
    req.payload.find({
      collection: 'xero-reference-data',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: {
        and: [
          { sourceTenantId: { equals: tenantID } },
          { resourceType: { equals: 'tax-rate' } },
          { code: { equals: taxType } },
          { status: { equals: 'active' } },
        ],
      },
    }),
  ])
  if (!account.docs[0] || !tax.docs[0]) {
    throw new AccountingIntegrationError(
      'invalid-billing-defaults',
      'Select an active revenue account and tax rate from the connected Xero organisation.',
    )
  }
}
