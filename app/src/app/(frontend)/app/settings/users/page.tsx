import Link from 'next/link'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import {
  InvitationCreateForm,
  InvitationRowActions,
} from '@/app/(frontend)/_components/InvitationManagementForms'
import { PageHeader } from '@/app/(frontend)/_components/PageHeader'
import { PendingSubmitButton } from '@/app/(frontend)/_components/PendingControls'
import { getInvitationManagementView, type InviteRole } from '@/lib/account-lifecycle/service'
import { getBusinessSettings } from '@/lib/member-app/data'
import { timezoneOptionsIncluding } from '@/lib/member-app/date-time'
import { requireAppSession } from '@/lib/member-app/session'

import { ownerTransitionAction, recoverIdentityAction } from './actions'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'People & invitations | Project Time',
}

export default async function UserSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    identityRecovery?: string | string[]
    ownership?: string | string[]
  }>
}) {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, ['owner', 'admin'])) redirect('/app')

  const [invitations, settings, users] = await Promise.all([
    getInvitationManagementView(session),
    getBusinessSettings(session),
    session.payload.find({
      collection: 'users',
      depth: 0,
      limit: 100,
      overrideAccess: false,
      req: session.req,
      sort: 'displayName',
    }),
  ])
  const params = await searchParams
  const recoverableUsers = users.docs.filter(
    (user) =>
      user.enabledLoginMethods?.includes('xero') &&
      (session.user.role === 'owner' || user.role !== 'owner'),
  )
  const roles: Array<{ label: string; value: InviteRole }> = [
    ...(session.user.role === 'owner'
      ? ([{ label: 'Administrator', value: 'admin' }] as const)
      : []),
    { label: 'Biller', value: 'biller' },
    { label: 'Time-entry user', value: 'member' },
  ]
  const dateTime = new Intl.DateTimeFormat(settings.locale, {
    dateStyle: settings.dateDisplayStyle,
    timeStyle: 'short',
    timeZone: session.user.timezone,
  })

  return (
    <div className="wide-page page-stack">
      <PageHeader
        action={
          <Link className="button button-secondary" href="/admin/collections/users">
            Manage users in Payload Admin ↗
          </Link>
        }
        breadcrumb={{ current: 'People & invitations', href: '/app/settings', label: 'Settings' }}
        description="Invite users without creating or sharing temporary passwords."
        title="People & invitations"
      />

      {session.user.role === 'owner' && params.ownership === 'changed' && (
        <div className="notice notice-success" role="status">
          Ownership changed and recorded in the audit history.
        </div>
      )}
      {session.user.role === 'owner' && params.ownership && params.ownership !== 'changed' && (
        <div className="notice notice-warning" role="alert">
          Ownership could not be changed. Check the target, recovery credential, and remaining
          owners.
        </div>
      )}
      {params.identityRecovery === 'revoked' && (
        <div className="notice notice-success" role="status">
          The identity link and local external sessions were revoked and audited.
        </div>
      )}
      {params.identityRecovery && params.identityRecovery !== 'revoked' && (
        <div className="notice notice-warning" role="alert">
          Identity recovery could not be completed. Check the target, confirmation, password, and
          recovery method.
        </div>
      )}

      <InvitationCreateForm
        defaultTimezone={settings.defaultTimezone}
        roles={roles}
        timezones={timezoneOptionsIncluding(settings.defaultTimezone)}
      />

      <section className="panel invitation-list-panel">
        <div className="integration-heading">
          <h2>Invitation history</h2>
          <span>{invitations.length} shown</span>
        </div>

        {invitations.length === 0 ? (
          <p>No invitations have been issued.</p>
        ) : (
          <div className="invitation-list">
            {invitations.map((invitation) => (
              <article className="invitation-item" key={invitation.id}>
                <div>
                  <div className="invitation-item-heading">
                    <strong>{invitation.displayName}</strong>
                    <span className={`status status-invitation-${invitation.status}`}>
                      {invitation.status}
                    </span>
                  </div>
                  <p>{invitation.email}</p>
                  <small>
                    {invitation.role} · issued {dateTime.format(new Date(invitation.issuedAt))} ·
                    expires {dateTime.format(new Date(invitation.expiresAt))} · delivery{' '}
                    {invitation.deliveryStatus}
                  </small>
                </div>
                <InvitationRowActions invitation={invitation} />
              </article>
            ))}
          </div>
        )}
      </section>

      <div className="notice">
        Invitation links are bearer credentials. Development shows each newly generated link once;
        production only sends it through the configured Resend account.
      </div>

      <details
        className="settings-disclosure"
        open={Boolean(params.ownership || params.identityRecovery)}
      >
        <summary>Advanced account administration</summary>
        <div className="settings-disclosure-content">
          {session.user.role === 'owner' && (
            <section className="settings-disclosure-section">
              <div>
                <h2>Ownership transition</h2>
                <p>
                  Promote an active password-capable user, or demote an owner after another recovery
                  owner is proven to remain. A different owner must perform a current owner’s
                  demotion.
                </p>
              </div>
              <form action={ownerTransitionAction} className="compact-form">
                <div className="form-grid">
                  <label className="field">
                    <span>Action</span>
                    <select name="action" required>
                      <option value="promote">Promote to owner</option>
                      <option value="demote">Demote owner to administrator</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Target user</span>
                    <select name="targetUserID" required>
                      {users.docs.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.displayName} ({user.role})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Current password</span>
                    <input
                      autoComplete="current-password"
                      name="password"
                      required
                      type="password"
                    />
                  </label>
                  <label className="field">
                    <span>Reason</span>
                    <input maxLength={1_000} minLength={10} name="reason" required />
                  </label>
                </div>
                <div className="form-actions">
                  <PendingSubmitButton
                    className="button button-danger"
                    pendingLabel="Updating ownership…"
                  >
                    Confirm ownership transition
                  </PendingSubmitButton>
                </div>
              </form>
            </section>
          )}

          <section className="settings-disclosure-section">
            <div>
              <h2>Revoke a compromised Xero identity link</h2>
              <p>
                This revokes the selected user’s Xero identity and all local external sessions while
                retaining email/password recovery. It never changes the business accounting
                connection. Administrators cannot recover an owner account.
              </p>
            </div>
            <form action={recoverIdentityAction} className="compact-form">
              <div className="form-grid">
                <label className="field">
                  <span>Linked user</span>
                  <select name="targetUserID" required>
                    {recoverableUsers.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.displayName} ({user.role})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Your current password</span>
                  <input autoComplete="current-password" name="password" required type="password" />
                </label>
                <label className="field">
                  <span>Reason</span>
                  <input maxLength={1_000} minLength={10} name="reason" required />
                </label>
                <label className="field">
                  <span>Type REVOKE XERO</span>
                  <input name="confirmation" pattern="REVOKE XERO" required />
                </label>
              </div>
              <div className="form-actions">
                <PendingSubmitButton
                  className="button button-danger"
                  disabled={recoverableUsers.length === 0}
                  pendingLabel="Revoking access…"
                >
                  Revoke identity and sessions
                </PendingSubmitButton>
              </div>
            </form>
          </section>
        </div>
      </details>
    </div>
  )
}
