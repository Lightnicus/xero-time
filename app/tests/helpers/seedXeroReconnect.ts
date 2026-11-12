import { getPayload } from 'payload'

import { cleanupNavigationRoleFixture, seedNavigationRoleFixture } from './seedUser'
import config from '../../src/payload.config.js'

export const RECONNECT_TENANT_NAME = 'Reconnect E2E Company'

/** Seeds every app role plus a configured Xero connection that Xero has stopped accepting. */
export async function seedXeroReconnectFixture(): Promise<void> {
  await seedNavigationRoleFixture()
  const payload = await getPayload({ config })
  await payload.create({
    collection: 'xero-connections',
    data: {
      connectionId: '11111111-eeee-4111-8111-111111111111',
      grantedScopes: [
        'offline_access',
        'accounting.invoices',
        'accounting.contacts',
        'accounting.settings.read',
      ],
      lastErrorCode: 'token-refresh-invalid-grant',
      lastErrorMessage:
        'Xero no longer accepts the saved authorization. Reconnect Xero to resume invoice exports.',
      // Only presence is checked when rendering; no Xero call is made in this fixture.
      oauthClientId: 'reconnect-e2e-accounting-client',
      oauthClientSecretEnvelope: 'reconnect-e2e-placeholder-envelope',
      singletonKey: 'business-accounting',
      status: 'action-required',
      tenantId: '22222222-eeee-4222-8222-222222222222',
      tenantName: RECONNECT_TENANT_NAME,
      tokenVersion: 1,
    },
    overrideAccess: true,
  })
}

export async function cleanupXeroReconnectFixture(): Promise<void> {
  await cleanupNavigationRoleFixture()
}
