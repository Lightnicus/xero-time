import { config as loadEnvironment } from 'dotenv'

loadEnvironment({ quiet: true })

if (process.env.RUN_XERO_DEMO_CONTRACT !== 'true') {
  throw new Error(
    'Set RUN_XERO_DEMO_CONTRACT=true only when a dedicated Xero Demo Company is connected.',
  )
}

const expectedTenantID = process.env.XERO_DEMO_EXPECTED_TENANT_ID?.trim()
if (!expectedTenantID) {
  throw new Error('Set XERO_DEMO_EXPECTED_TENANT_ID to pin the read-only contract run.')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const resources = [
  'Organisation',
  'Organisation/Actions',
  'Accounts',
  'TaxRates',
  'Currencies',
  'Items',
  'Contacts',
] as const

const [
  { getPayload },
  { default: config },
  { createAccountingSystemSession, getValidAccountingAccessToken, resolveAccountingRuntime },
] = await Promise.all([
  import('payload'),
  import('../../src/payload.config'),
  import('../../src/lib/xero/accounting/service'),
])

const payload = await getPayload({ config })
try {
  const session = await createAccountingSystemSession(payload)
  const runtime = await resolveAccountingRuntime(session)
  const client = runtime.client
  const token = await getValidAccountingAccessToken(session, runtime)
  if (token.connection.tenantId !== expectedTenantID) {
    throw new Error('The connected tenant does not match XERO_DEMO_EXPECTED_TENANT_ID.')
  }

  for (const path of resources) {
    const response = await client.accountingGet(
      token.accessToken,
      expectedTenantID,
      path,
      path === 'Contacts' ? { page: '1' } : undefined,
    )
    if (!isRecord(response.data)) {
      throw new Error(`Xero returned an invalid ${path} contract response.`)
    }
    if (path === 'Organisation') {
      const organisations = response.data.Organisations
      const organisation = Array.isArray(organisations) ? organisations[0] : undefined
      if (!isRecord(organisation) || organisation.OrganisationID !== expectedTenantID) {
        throw new Error('Xero returned organisation data for an unexpected tenant.')
      }
    }
    if (path === 'Organisation/Actions') {
      const actions = response.data.Actions
      const canCreateDraftInvoice =
        Array.isArray(actions) &&
        actions.some(
          (action) =>
            isRecord(action) && action.Name === 'CreateDraftInvoice' && action.Status === 'ALLOWED',
        )
      const canDeleteDraftInvoice =
        Array.isArray(actions) &&
        actions.some(
          (action) =>
            isRecord(action) && action.Name === 'DeleteDraftInvoice' && action.Status === 'ALLOWED',
        )
      if (!canCreateDraftInvoice) {
        throw new Error('The connected Xero user cannot create draft invoices in this tenant.')
      }
      if (!canDeleteDraftInvoice) {
        throw new Error('The connected Xero user cannot delete draft invoices in this tenant.')
      }
    }
    if (path === 'Items') {
      const items = response.data.Items
      if (!Array.isArray(items)) {
        throw new Error('Xero returned an invalid Items contract response.')
      }
      for (const item of items) {
        if (
          !isRecord(item) ||
          typeof item.ItemID !== 'string' ||
          typeof item.Code !== 'string' ||
          (typeof item.Name !== 'undefined' && typeof item.Name !== 'string') ||
          typeof item.IsSold !== 'boolean' ||
          typeof item.IsPurchased !== 'boolean' ||
          typeof item.IsTrackedAsInventory !== 'boolean' ||
          (item.SalesDetails !== null &&
            typeof item.SalesDetails !== 'undefined' &&
            !isRecord(item.SalesDetails))
        ) {
          throw new Error('Xero returned an invalid Item contract response.')
        }
      }
    }
  }

  payload.logger.info({
    event: 'xero-demo-read-contract-passed',
    resources,
  })
} finally {
  await payload.destroy()
}
