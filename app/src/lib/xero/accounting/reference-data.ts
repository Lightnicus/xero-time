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

type ReferenceResource = {
  code?: string
  metadata?: Record<string, unknown>
  name: string
  resourceType:
    | 'account'
    | 'currency'
    | 'item'
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

const strictOptionalString = (value: unknown, max: number): string | undefined => {
  if (value === null || typeof value === 'undefined' || value === '') return undefined
  if (typeof value !== 'string' || value.length > max || value.trim().length === 0) {
    throw new AccountingIntegrationError(
      'invalid-reference-response',
      'Xero returned invalid accounting reference data.',
    )
  }
  return value.trim()
}

const requiredBoolean = (value: unknown): boolean => {
  if (typeof value !== 'boolean') {
    throw new AccountingIntegrationError(
      'invalid-reference-response',
      'Xero returned invalid accounting reference data.',
    )
  }
  return value
}

const optionalFiniteNumber = (value: unknown): number | undefined => {
  if (value === null || typeof value === 'undefined') return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AccountingIntegrationError(
      'invalid-reference-response',
      'Xero returned invalid accounting reference data.',
    )
  }
  return value
}

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

const parseItems = (value: unknown): ReferenceResource[] =>
  arrayFrom(value, 'Items').map((candidate) => {
    if (!isRecord(candidate)) {
      throw new AccountingIntegrationError(
        'invalid-reference-response',
        'Xero returned invalid accounting reference data.',
      )
    }
    const itemID = requiredString(candidate.ItemID, 100)
    const code = requiredString(candidate.Code, 30)
    const name = strictOptionalString(candidate.Name, 50) ?? code
    const isSold = requiredBoolean(candidate.IsSold)
    const isPurchased = requiredBoolean(candidate.IsPurchased)
    const isTrackedAsInventory = requiredBoolean(candidate.IsTrackedAsInventory)
    const salesDescription = strictOptionalString(candidate.Description, 4_000)
    const salesDetailsValue = candidate.SalesDetails
    if (
      salesDetailsValue !== null &&
      typeof salesDetailsValue !== 'undefined' &&
      !isRecord(salesDetailsValue)
    ) {
      throw new AccountingIntegrationError(
        'invalid-reference-response',
        'Xero returned invalid accounting reference data.',
      )
    }
    const salesDetails = isRecord(salesDetailsValue)
      ? {
          accountCode: strictOptionalString(salesDetailsValue.AccountCode, 100),
          taxType: strictOptionalString(salesDetailsValue.TaxType, 100),
          unitPrice: optionalFiniteNumber(salesDetailsValue.UnitPrice),
        }
      : undefined

    return {
      code,
      metadata: {
        isPurchased,
        isSold,
        isTrackedAsInventory,
        salesDescription,
        salesDetails,
      },
      name,
      resourceType: 'item',
      // The Items API does not expose archive status. IsSold only represents
      // whether the item is currently selectable on a sales transaction.
      status: isSold ? 'active' : 'unavailable',
      type: isTrackedAsInventory ? 'tracked' : 'untracked',
      xeroId: itemID,
    }
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

const parseOrganisation = (value: unknown, tenantID: string): ReferenceResource[] => {
  const organisations = arrayFrom(value, 'Organisations')
  const organisation = organisations[0]
  if (organisations.length !== 1 || !isRecord(organisation)) {
    throw new AccountingIntegrationError(
      'invalid-reference-response',
      'Xero returned invalid organisation data.',
    )
  }
  const organisationID = requiredString(organisation.OrganisationID, 100)
  if (organisation.OrganisationID !== tenantID) {
    throw new AccountingIntegrationError(
      'wrong-tenant',
      'The Xero organisation response does not match the pinned organisation.',
    )
  }
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
  ]
}

const parseOrganisationActions = (value: unknown): ReferenceResource[] =>
  arrayFrom(value, 'Actions').flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const name = requiredString(candidate.Name, 100)
    const providerStatus = requiredString(candidate.Status, 100).toUpperCase()
    return [
      {
        code: name,
        metadata: { providerStatus },
        name,
        resourceType: 'organisation-action',
        status: providerStatus === 'ALLOWED' ? 'active' : 'unavailable',
        type: providerStatus,
        xeroId: name,
      },
    ]
  })

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
  const [
    organisation,
    organisationActions,
    accounts,
    taxRates,
    currencies,
    trackingCategories,
    items,
  ] = await Promise.all([
    client.accountingGet(accessToken, tenantID, 'Organisation'),
    client.accountingGet(accessToken, tenantID, 'Organisation/Actions'),
    client.accountingGet(accessToken, tenantID, 'Accounts'),
    client.accountingGet(accessToken, tenantID, 'TaxRates'),
    client.accountingGet(accessToken, tenantID, 'Currencies'),
    client.accountingGet(accessToken, tenantID, 'TrackingCategories'),
    client.accountingGet(accessToken, tenantID, 'Items'),
  ])
  const resources = [
    ...parseOrganisation(organisation.data, tenantID),
    ...parseOrganisationActions(organisationActions.data),
    ...parseAccounts(accounts.data),
    ...parseTaxRates(taxRates.data),
    ...parseCurrencies(currencies.data),
    ...parseTrackingCategories(trackingCategories.data),
    ...parseItems(items.data),
  ]
  await persistReferences(session, tenantID, resources, machineActor)
  return {
    capabilityAvailable: resources.some(
      (item) =>
        item.resourceType === 'organisation-action' &&
        item.code === 'CreateDraftInvoice' &&
        item.status === 'active',
    ),
    resourceCount: resources.length,
  }
}
