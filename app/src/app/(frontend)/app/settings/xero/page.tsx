import Link from 'next/link'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { getBusinessSettings } from '@/lib/member-app/data'
import { requireAppSession } from '@/lib/member-app/session'
import { getAccountingConnectionView } from '@/lib/xero/accounting/service'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Xero accounting | Project Time',
}

type SearchValue = string | string[] | undefined

const value = (input: SearchValue): string => (typeof input === 'string' ? input : '')

const errorMessage = (code: string): string | null => {
  const messages: Record<string, string> = {
    'already-connected': 'A Xero organisation is already connected.',
    'authorization-denied': 'Xero authorization was cancelled or denied.',
    'code-exchange-network-error': 'Xero could not be reached. Start the connection again.',
    'credential-boundary':
      'Use a different client ID and secret from the optional Xero identity application.',
    'disconnect-before-config-change':
      'Disconnect Xero accounting before replacing its OAuth application credentials.',
    forbidden: 'Only an owner or administrator can manage the accounting connection.',
    'handover-required':
      'A different Xero authorizer requires the explicit handover workflow below.',
    'invalid-handover-reason': 'Enter a handover reason of at least 10 characters.',
    'invalid-client-id': 'Enter the client ID from the dedicated Xero accounting application.',
    'invalid-client-secret':
      'Enter the client secret from the dedicated Xero accounting application.',
    'identity-scope-rejected':
      'The accounting app returned identity permissions. Check that the dedicated accounting client is configured.',
    'invalid-access-token': 'Xero returned an accounting token that could not be verified.',
    'invalid-callback': 'Xero returned an invalid callback. Start the connection again.',
    'invalid-scopes': 'Xero did not grant exactly the required accounting permissions.',
    'invalid-state': 'The Xero connection attempt is invalid or expired. Start again.',
    'no-organisation': 'No Xero organisation was authorized.',
    'not-configured': 'The Xero accounting integration is not configured.',
    'not-connected': 'There is no active Xero accounting connection.',
    'operation-failed': 'The accounting operation could not be completed.',
    'reauthentication-failed': 'Password confirmation failed.',
    'state-replayed': 'That Xero connection attempt has already been used.',
    'token-refresh-invalid_grant': 'Xero requires this organisation to be reconnected.',
    'wrong-tenant': 'The authorized organisation does not match the pinned Xero organisation.',
    'unsafe-export-state':
      'Resolve active, ambiguous, or action-required exports before changing accounting authority.',
  }
  return code ? (messages[code] ?? 'The Xero accounting operation could not be completed.') : null
}

export default async function XeroAccountingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, SearchValue>>
}) {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, ['owner', 'admin'])) redirect('/app')

  const params = await searchParams
  const [connection, settings] = await Promise.all([
    getAccountingConnectionView(session),
    getBusinessSettings(session),
  ])
  const error = errorMessage(value(params.error))
  const dateTimeFormatter = new Intl.DateTimeFormat(settings.locale, {
    dateStyle: settings.dateDisplayStyle,
    timeStyle: 'short',
    timeZone: session.user.timezone,
  })
  const formatDateTime = (date?: string): string =>
    date ? dateTimeFormatter.format(new Date(date)) : 'Not yet'
  const connectLabel = connection.status === 'not-connected' ? 'Connect Xero' : 'Reconnect Xero'

  return (
    <div className="narrow-page page-stack">
      <div className="breadcrumb">
        <Link href="/app">My time</Link>
        <span aria-hidden="true">/</span>
        <span>Xero accounting</span>
      </div>

      <section className="page-heading compact">
        <div>
          <p className="eyebrow">Business integration</p>
          <h1>Xero accounting</h1>
          <p>
            Connect the one Xero organisation used for customer mapping and draft invoice exports.
            This is separate from optional user sign-in with Xero.
          </p>
        </div>
      </section>

      {error && (
        <div aria-live="polite" className="notice notice-warning" role="alert">
          {error}
        </div>
      )}
      {params.connected === '1' && (
        <div aria-live="polite" className="notice notice-success" role="status">
          Xero organisation connected and pinned.
        </div>
      )}
      {params.configured === '1' && (
        <div aria-live="polite" className="notice notice-success" role="status">
          Xero accounting application credentials saved securely.
        </div>
      )}
      {params.checked === '1' && (
        <div aria-live="polite" className="notice notice-success" role="status">
          Xero connection checked.
        </div>
      )}
      {params.references === '1' && (
        <div
          aria-live="polite"
          className={
            params.capability === 'yes' ? 'notice notice-success' : 'notice notice-warning'
          }
          role="status"
        >
          {params.capability === 'yes'
            ? 'Xero accounts, tax rates, currencies, and organisation capabilities refreshed.'
            : 'Reference data refreshed, but Xero did not report CreateDraftInvoice capability.'}
        </div>
      )}
      {params.disconnected === '1' && (
        <div
          aria-live="polite"
          className={params.remote === 'check' ? 'notice notice-warning' : 'notice notice-success'}
          role="status"
        >
          {params.remote === 'check'
            ? 'Local credentials were removed. Check Xero Connected Apps because remote cleanup could not be confirmed.'
            : 'Xero accounting disconnected and local credentials removed.'}
        </div>
      )}

      <section className="panel integration-panel">
        <div>
          <span
            className={`status ${connection.configured ? 'status-xero-connected' : 'status-reserved'}`}
          >
            {connection.configured ? 'Credentials configured' : 'Not configured'}
          </span>
          <h2>Accounting OAuth application</h2>
          <p>
            Create a dedicated Auth Code application in Xero, register the exact callback below,
            then save its client credentials here. The secret is encrypted before it enters MongoDB
            and is never displayed again.
          </p>
        </div>
        <div>
          <strong>OAuth callback URI</strong>
          <code>{connection.callbackURI}</code>
        </div>
        {connection.status === 'connected' ? (
          <div className="notice">
            Disconnect the current organisation before replacing these application credentials.
          </div>
        ) : (
          <form
            action="/api/integrations/xero/accounting/configure"
            className="compact-form"
            method="post"
          >
            <label className="field">
              <span>Xero accounting client ID</span>
              <input
                autoComplete="off"
                defaultValue={connection.clientID}
                maxLength={200}
                minLength={5}
                name="clientID"
                required
              />
            </label>
            <label className="field">
              <span>Xero accounting client secret</span>
              <input
                autoComplete="new-password"
                maxLength={500}
                minLength={10}
                name="clientSecret"
                placeholder={
                  connection.clientSecretConfigured
                    ? 'Leave blank to keep the saved secret'
                    : 'Paste the secret generated by Xero'
                }
                required={!connection.clientSecretConfigured}
                type="password"
              />
              <small>
                {connection.clientSecretConfigured
                  ? 'A secret is stored. Enter a value only to replace it.'
                  : 'The plaintext value is accepted only by this protected server action.'}
              </small>
            </label>
            <label className="field">
              <span>Current account password</span>
              <input autoComplete="current-password" name="password" required type="password" />
            </label>
            <button className="button button-secondary" type="submit">
              {connection.configured ? 'Update OAuth application' : 'Save OAuth application'}
            </button>
          </form>
        )}
      </section>

      {connection.configured && (
        <>
          <section aria-labelledby="connection-status-heading" className="panel integration-panel">
            <div className="integration-heading">
              <div>
                <span className={`status status-xero-${connection.status}`}>
                  {connection.status.replaceAll('-', ' ')}
                </span>
                <h2 id="connection-status-heading">
                  {connection.tenantName ?? 'No Xero organisation connected'}
                </h2>
              </div>
              {connection.status === 'connected' && (
                <div className="button-row">
                  <form action="/api/integrations/xero/accounting/health" method="post">
                    <button className="button button-secondary" type="submit">
                      Check connection
                    </button>
                  </form>
                  <form action="/api/integrations/xero/accounting/reference-data" method="post">
                    <button className="button button-secondary" type="submit">
                      Refresh reference data
                    </button>
                  </form>
                </div>
              )}
            </div>

            {connection.tenantId && (
              <dl className="detail-list integration-details">
                <div>
                  <dt>Organisation ID</dt>
                  <dd>{connection.tenantId}</dd>
                </div>
                <div>
                  <dt>Connection ID</dt>
                  <dd>{connection.connectionId}</dd>
                </div>
                <div>
                  <dt>Authorized</dt>
                  <dd>{formatDateTime(connection.authorizedAt)}</dd>
                </div>
                <div>
                  <dt>Last token refresh</dt>
                  <dd>{formatDateTime(connection.lastRefreshedAt)}</dd>
                </div>
                <div>
                  <dt>Last health check</dt>
                  <dd>{formatDateTime(connection.lastHealthCheckAt)}</dd>
                </div>
                <div>
                  <dt>Last reference refresh</dt>
                  <dd>{formatDateTime(connection.lastReferenceDataSyncAt)}</dd>
                </div>
                <div>
                  <dt>Xero authorizer ID</dt>
                  <dd>{connection.xeroUserId ?? 'Unavailable'}</dd>
                </div>
                <div>
                  <dt>Local initiator ID</dt>
                  <dd>{connection.initiatedBy ?? 'Unavailable'}</dd>
                </div>
                <div className="detail-wide">
                  <dt>Accounting scopes</dt>
                  <dd>{connection.grantedScopes.join(', ') || 'None'}</dd>
                </div>
              </dl>
            )}

            {connection.lastErrorMessage && (
              <div className="notice notice-warning integration-notice">
                {connection.lastErrorMessage}
              </div>
            )}
          </section>

          {connection.status !== 'connected' && (
            <form
              action="/api/integrations/xero/accounting/start"
              className="form-section integration-form"
              method="post"
            >
              <div>
                <h2>{connectLabel}</h2>
                <p>
                  You will be sent to Xero to authorize invoices, contacts, settings read access,
                  and offline token refresh. Confirm your local password first.
                </p>
              </div>
              {connection.tenantId && (
                <div className="notice">
                  Reconnection must return the pinned organisation:{' '}
                  <strong>{connection.tenantName}</strong>.
                </div>
              )}
              <label className="field" htmlFor="connectPassword">
                <span>Current password</span>
                <input
                  autoComplete="current-password"
                  id="connectPassword"
                  name="password"
                  required
                  type="password"
                />
              </label>
              <div className="form-actions">
                <button className="button button-primary" type="submit">
                  {connectLabel}
                </button>
              </div>
            </form>
          )}

          {connection.status === 'connected' && (
            <form
              action="/api/integrations/xero/accounting/handover"
              className="form-section integration-form"
              method="post"
            >
              <div>
                <h2>Change accounting authorizer</h2>
                <p>
                  Explicitly replace the server-held grant while pinning the same organisation. The
                  old grant remains active unless the new tenant, scopes, token identity, and local
                  transaction all validate.
                </p>
              </div>
              <label className="field">
                <span>Reason</span>
                <textarea maxLength={1_000} minLength={10} name="reason" required rows={3} />
              </label>
              <label className="field">
                <span>Current password</span>
                <input autoComplete="current-password" name="password" required type="password" />
              </label>
              <label className="confirmation-field">
                <input name="confirmation" required type="checkbox" value="handover" />
                <span>I understand the new Xero login must authorize this same organisation.</span>
              </label>
              <button className="button button-secondary" type="submit">
                Start authorizer handover
              </button>
            </form>
          )}

          {connection.status === 'connected' && (
            <form
              action="/api/integrations/xero/accounting/disconnect"
              className="danger-zone integration-disconnect"
              method="post"
            >
              <div>
                <h2>Disconnect accounting</h2>
                <p>
                  Stops future Xero operations and removes locally usable credentials. Historical
                  tenant and invoice mappings are retained.
                </p>
              </div>
              <div className="disconnect-fields">
                <label className="field" htmlFor="disconnectReason">
                  <span>Reason</span>
                  <textarea id="disconnectReason" minLength={10} name="reason" required rows={3} />
                </label>
                <label className="field" htmlFor="disconnectPassword">
                  <span>Current password</span>
                  <input
                    autoComplete="current-password"
                    id="disconnectPassword"
                    name="password"
                    required
                    type="password"
                  />
                </label>
                <label className="confirmation-field">
                  <input name="confirmation" required type="checkbox" value="disconnect" />
                  <span>I understand this stops Xero exports until reconnection.</span>
                </label>
                <button className="button button-danger" type="submit">
                  Disconnect Xero
                </button>
              </div>
            </form>
          )}
        </>
      )}

      <section className="notice integration-boundary">
        <strong>Credential boundary:</strong> accounting tokens are encrypted server-side and are
        never returned by Payload APIs, rendered here, or used as an application login session.
      </section>
    </div>
  )
}
