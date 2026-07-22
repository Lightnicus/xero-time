import type { IdentitySecurityView } from '@/lib/xero/identity/service'

import { PendingNavigationForm, PendingSubmitButton } from './PendingControls'
import { revokeExternalSessionAction, unlinkXeroIdentityAction } from '../app/profile/actions'

export function IdentitySecurityPanel({
  canLink,
  configured,
  security,
}: {
  canLink: boolean
  configured: boolean
  security: IdentitySecurityView
}) {
  if (!security.identity && security.sessions.length === 0 && !(configured && canLink)) {
    return (
      <p className="account-availability-note">
        Xero identity sign-in is not currently available for this account.
      </p>
    )
  }

  return (
    <section aria-labelledby="login-methods-heading" className="panel page-stack">
      <div>
        <h3 id="login-methods-heading">Login methods and sessions</h3>
        <p>
          Email and password remains available for recovery. Xero identity sign-in is separate from
          the business accounting connection.
        </p>
      </div>

      {security.identity ? (
        <div className="security-card">
          <div>
            <strong>Linked Xero identity</strong>
            <p>
              {security.identity.displayName ?? 'Xero user'}
              {security.identity.email ? ` · ${security.identity.email}` : ''}
            </p>
            <small>Linked {new Date(security.identity.linkedAt).toLocaleString()}</small>
          </div>
          <form action={unlinkXeroIdentityAction} className="compact-form">
            <label className="field">
              <span>Current password</span>
              <input autoComplete="current-password" name="password" required type="password" />
            </label>
            <label className="field">
              <span>Reason</span>
              <input maxLength={1_000} minLength={3} name="reason" required />
            </label>
            <PendingSubmitButton className="button button-danger" pendingLabel="Unlinking…">
              Unlink Xero identity
            </PendingSubmitButton>
          </form>
        </div>
      ) : configured && canLink ? (
        <PendingNavigationForm
          action="/api/auth/xero/identity/start"
          className="compact-form"
          method="post"
        >
          <input name="purpose" type="hidden" value="identity-link" />
          <input name="returnPath" type="hidden" value="/app/profile?xero=linked" />
          <label className="field">
            <span>Confirm current password</span>
            <input autoComplete="current-password" name="password" required type="password" />
            <small>Confirmation is required before leaving for Xero.</small>
          </label>
          <PendingSubmitButton className="button button-xero" pendingLabel="Opening Xero…">
            <span aria-hidden="true" className="xero-wordmark">
              xero
            </span>
            Link Xero identity
          </PendingSubmitButton>
        </PendingNavigationForm>
      ) : (
        <p className="muted-copy">Xero identity linking is not currently available.</p>
      )}

      <div>
        <h3>External sign-in sessions</h3>
        {security.sessions.length === 0 ? (
          <p className="muted-copy">No active Xero identity sessions.</p>
        ) : (
          <div className="session-list">
            {security.sessions.map((item) => (
              <div className="session-row" key={item.id}>
                <div>
                  <strong>
                    {item.deviceLabel ?? 'Browser session'} {item.current ? '(this session)' : ''}
                  </strong>
                  <small>
                    Last used {new Date(item.lastSeenAt).toLocaleString()} · expires{' '}
                    {new Date(item.expiresAt).toLocaleDateString()}
                  </small>
                </div>
                <form action={revokeExternalSessionAction}>
                  <input name="sessionID" type="hidden" value={item.id} />
                  <PendingSubmitButton className="button button-secondary" pendingLabel="Revoking…">
                    Revoke
                  </PendingSubmitButton>
                </form>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
