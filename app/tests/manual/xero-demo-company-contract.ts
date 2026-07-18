import { config as loadEnvironment } from 'dotenv'

loadEnvironment()

if (process.env.RUN_XERO_DEMO_CONTRACT !== 'true') {
  throw new Error(
    'Set RUN_XERO_DEMO_CONTRACT=true only when a dedicated Xero Demo Company is connected.',
  )
}

const expectedTenantID = process.env.XERO_DEMO_EXPECTED_TENANT_ID?.trim()
if (!expectedTenantID) {
  throw new Error('Set XERO_DEMO_EXPECTED_TENANT_ID to pin the read-only contract run.')
}

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

  for (const path of ['Organisation', 'Accounts', 'TaxRates', 'Currencies', 'Contacts']) {
    const response = await client.accountingGet(
      token.accessToken,
      expectedTenantID,
      path,
      path === 'Contacts' ? { page: '1' } : undefined,
    )
    if (!response.data || typeof response.data !== 'object') {
      throw new Error(`Xero returned an invalid ${path} contract response.`)
    }
  }

  payload.logger.info({
    event: 'xero-demo-read-contract-passed',
    resources: ['Organisation', 'Accounts', 'TaxRates', 'Currencies', 'Contacts'],
  })
} finally {
  await payload.destroy()
}
