import Link from 'next/link'

import { PageHeader } from '@/app/(frontend)/_components/PageHeader'
import {
  PendingNavigationForm,
  PendingSubmitButton,
} from '@/app/(frontend)/_components/PendingControls'
import { getBusinessSettings } from '@/lib/member-app/data'
import { requireAppSession } from '@/lib/member-app/session'
import { getXeroConnectionAlert } from '@/lib/xero/accounting/connection-alert'
import { connectionRecoveryCause } from '@/lib/xero/accounting/recovery'
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
    'code-exchange-invalid-client':
      'Xero rejected the saved client ID or secret. Update both from the same dedicated Xero accounting application, then try again.',
    'code-exchange-invalid-grant':
      'The Xero callback expired or was already used. Start the connection again.',
    'code-exchange-network-error': 'Xero could not be reached. Start the connection again.',
    'disconnect-before-config-change':
      'Disconnect Xero accounting before replacing its OAuth application credentials.',
    forbidden: 'Sign in again to manage the accounting connection.',
    'invalid-client-id': 'Enter the client ID from the dedicated Xero accounting application.',
    'invalid-client-secret':
      'Enter the client secret from the dedicated Xero accounting application.',
    'identity-scope-rejected':
      'The accounting app returned identity permissions. Check that the dedicated accounting client is configured.',
    'invalid-access-token': 'Xero returned an accounting token that could not be verified.',
    'invalid-callback': 'Xero returned an invalid callback. Start the connection again.',
    'invalid-organisation-response':
      'Xero did not return valid organisation capability data. Start the connection again.',
    'invalid-scopes': 'Xero did not grant exactly the required accounting permissions.',
    'invalid-state': 'The Xero connection attempt is invalid or expired. Start again.',
    'no-organisation': 'No Xero organisation was authorized.',
    'missing-create-draft-capability':
      "The selected Xero organisation did not allow this connection to create draft invoices. Check the authorizing user's invoice permissions in Xero, then reconnect.",
    'not-configured': 'The Xero accounting integration is not configured.',
    'not-connected': 'There is no active Xero accounting connection.',
    'reconnect-required': 'Xero needs to be reconnected before this can continue.',
    'token-refresh-invalid-client':
      'Xero rejected the saved client ID or secret. Update the OAuth application credentials, then reconnect.',
    'operation-failed': 'The accounting operation could not be completed.',
    'state-replayed': 'That Xero connection attempt has already been used.',
    'token-refresh-invalid-grant': 'Xero requires this organisation to be reconnected.',
    'token-refresh-invalid_grant': 'Xero requires this organisation to be reconnected.',
    'unsafe-export-state':
      'Some invoice exports are still in progress. Let them finish or cancel them on the export history page, then disconnect.',
    'wrong-tenant':
      "Xero returned a different organisation from the pinned one. Reconnect and choose the pinned organisation on Xero's organisation screen.",
  }
  return code ? (messages[code] ?? 'The Xero accounting operation could not be completed.') : null
}

export default async function XeroAccountingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, SearchValue>>
}) {
  const session = await requireAppSession()

  const params = await searchParams
  const [connection, settings, connectionAlert] = await Promise.all([
    getAccountingConnectionView(session),
    getBusinessSettings(session),
    getXeroConnectionAlert(session),
  ])
  const errorCode = value(params.error)
  const error = errorMessage(errorCode)
  const dateTimeFormatter = new Intl.DateTimeFormat(settings.locale, {
    dateStyle: settings.dateDisplayStyle,
    timeStyle: 'short',
    timeZone: session.user.timezone,
  })
  const formatDateTime = (date?: string): string =>
    date ? dateTimeFormatter.format(new Date(date)) : 'Not yet'
  const connectLabel = connection.tenantId ? 'Reconnect Xero' : 'Connect Xero'
  const needsRecovery =
    Boolean(connection.tenantId) &&
    (connection.status === 'action-required' || connection.status === 'disconnected')
  const recoveryCause = connectionRecoveryCause(connection.lastErrorCode, connection.status)
  const organisationName = connection.tenantName ?? 'the pinned organisation'
  const waitingExports = connectionAlert?.waitingExports ?? 0

  return (
    <div className="narrow-page page-stack">
      <PageHeader
        breadcrumb={{ current: 'Xero accounting', href: '/app/settings', label: 'Settings' }}
        description="Connect the one Xero organisation used for customer mapping and draft invoice exports."
        title="Xero accounting"
      />

      {error && (
        <div aria-live="polite" className="notice notice-warning" role="alert">
          {error}
        </div>
      )}
      {params.connected === '1' && params.references === '1' && params.capability === 'yes' && (
        <div aria-live="polite" className="notice notice-success" role="status">
          Xero organisation connected and billing reference data is ready.
        </div>
      )}
      {params.connected === '1' && !params.references && (
        <div aria-live="polite" className="notice notice-success" role="status">
          Xero organisation connected and pinned.
        </div>
      )}
      {params.connected === '1' && params.references === 'failed' && (
        <div aria-live="polite" className="notice notice-warning" role="alert">
          Xero is connected, but its sales items, accounts, tax rates, currencies, tracking, and
          invoice capability could not be loaded.{' '}
          <Link href="#reference-data">Refresh Xero reference data</Link> before exporting invoices.
        </div>
      )}
      {params.connected === '1' && params.references === '1' && params.capability !== 'yes' && (
        <div aria-live="polite" className="notice notice-warning" role="alert">
          Xero is connected, but the organisation did not report permission to create draft
          invoices. Check the authorizing user&apos;s invoice permissions in Xero, then reconnect.
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
      {params.connected !== '1' && params.references === '1' && (
        <div
          aria-live="polite"
          className={
            params.capability === 'yes' ? 'notice notice-success' : 'notice notice-warning'
          }
          role="status"
        >
          {params.capability === 'yes'
            ? 'Xero sales items, accounts, tax rates, currencies, tracking, and organisation capabilities refreshed.'
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
          <PendingNavigationForm
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
            <PendingSubmitButton
              className="button button-secondary"
              pendingLabel={
                connection.configured ? 'Updating OAuth application…' : 'Saving OAuth application…'
              }
            >
              {connection.configured ? 'Update OAuth application' : 'Save OAuth application'}
            </PendingSubmitButton>
          </PendingNavigationForm>
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
                  <PendingNavigationForm
                    action="/api/integrations/xero/accounting/health"
                    method="post"
                  >
                    <PendingSubmitButton
                      className="button button-secondary"
                      pendingLabel="Checking connection…"
                    >
                      Check connection
                    </PendingSubmitButton>
                  </PendingNavigationForm>
                  <PendingNavigationForm
                    action="/api/integrations/xero/accounting/reference-data"
                    id="reference-data"
                    method="post"
                  >
                    <PendingSubmitButton
                      className="button button-secondary"
                      pendingLabel="Refreshing reference data…"
                    >
                      Refresh reference data
                    </PendingSubmitButton>
                  </PendingNavigationForm>
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

            {/* The recovery section below explains an action-required failure in full. */}
            {connection.lastErrorMessage && connection.status !== 'action-required' && (
              <div className="notice notice-warning integration-notice">
                {connection.lastErrorMessage}
              </div>
            )}
          </section>

          {needsRecovery && (
            <section
              aria-labelledby="recovery-heading"
              className="panel integration-panel"
              id="reconnect"
            >
              <div>
                <h2 id="recovery-heading">
                  {connection.status === 'disconnected'
                    ? 'Reconnect Xero'
                    : 'Xero stopped working: reconnect to resume invoicing'}
                </h2>
                <p>
                  {recoveryCause === 'client-credentials'
                    ? 'Xero rejected the client ID or secret saved for the accounting application, for example because the secret was regenerated in the Xero developer portal.'
                    : recoveryCause === 'organisation-removed'
                      ? `${organisationName} is no longer connected to this app in Xero. Someone may have disconnected it from Xero's Connected Apps page.`
                      : recoveryCause === 'authorizer-mismatch'
                        ? 'Xero returned a token for a different Xero user from the one who connected the organisation.'
                        : recoveryCause === 'authorization-expired'
                          ? 'Xero no longer accepts the saved authorization. This happens when the app is disconnected in Xero, the Xero user who connected it loses access, or the connection goes unused for 60 days.'
                          : 'Xero accounting is not connected, so invoices cannot be sent to Xero.'}
                </p>
              </div>
              <ol className="recovery-steps">
                {recoveryCause === 'client-credentials' && (
                  <li>
                    In the Xero developer portal, open the dedicated accounting application,
                    generate a new client secret, and save the client ID and new secret under{' '}
                    <strong>Accounting OAuth application</strong> above.
                  </li>
                )}
                <li>
                  In another tab, sign in to Xero as a user who can create invoices in{' '}
                  <strong>{organisationName}</strong>. If you are signed in to Xero as someone else,
                  sign out first.
                </li>
                <li>
                  Select <strong>Reconnect Xero</strong> below. In Xero, choose{' '}
                  <strong>{organisationName}</strong> and allow access. If Xero says the
                  organisation is already connected, continue anyway. Any Xero user who can create
                  invoices there will do; it does not have to be the one who connected it before.
                </li>
                <li>
                  {waitingExports > 0
                    ? `${waitingExports} paused invoice ${waitingExports === 1 ? 'export resumes' : 'exports resume'} automatically once Xero is reconnected.`
                    : 'Invoice exports work again as soon as Xero is reconnected.'}
                </li>
              </ol>
            </section>
          )}

          {connection.status !== 'connected' && (
            <PendingNavigationForm
              action="/api/integrations/xero/accounting/start"
              className="form-section integration-form"
              method="post"
            >
              <div>
                <h2>{connectLabel}</h2>
                <p>
                  You will be sent to Xero to authorize invoices, contacts, settings read access,
                  and offline token refresh.
                </p>
                <p>
                  If Xero says the organisation is already connected, continue through that screen
                  so Xero can return here and finish the local connection.
                </p>
              </div>
              {connection.tenantId && (
                <div className="notice">
                  Reconnection must return the pinned organisation:{' '}
                  <strong>{connection.tenantName}</strong>.
                </div>
              )}
              <div className="form-actions">
                <PendingSubmitButton
                  className="button button-primary"
                  pendingLabel={connection.tenantId ? 'Reconnecting Xero…' : 'Connecting Xero…'}
                >
                  {connectLabel}
                </PendingSubmitButton>
              </div>
            </PendingNavigationForm>
          )}

          {connection.status === 'connected' && (
            <details className="settings-disclosure settings-disclosure-danger">
              <summary>Disconnect Xero</summary>
              <div className="settings-disclosure-content">
                <PendingNavigationForm
                  action="/api/integrations/xero/accounting/disconnect"
                  className="danger-zone integration-disconnect"
                  method="post"
                >
                  <div>
                    <h2>Disconnect accounting</h2>
                    <p>
                      Stops future Xero operations and removes locally usable credentials.
                      Historical tenant and invoice mappings are retained.
                    </p>
                  </div>
                  <div className="disconnect-fields">
                    <label className="confirmation-field">
                      <input name="confirmation" required type="checkbox" value="disconnect" />
                      <span>I understand this stops Xero exports until reconnection.</span>
                    </label>
                    <PendingSubmitButton
                      className="button button-danger"
                      pendingLabel="Disconnecting Xero…"
                    >
                      Disconnect Xero
                    </PendingSubmitButton>
                  </div>
                </PendingNavigationForm>
              </div>
            </details>
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
